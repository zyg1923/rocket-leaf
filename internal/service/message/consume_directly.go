package message

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/amigoer/rocket-leaf/internal/service/internal/resource"

	admin "github.com/amigoer/rocketmq-admin-go"
	"github.com/amigoer/rocketmq-admin-go/protocol/remoting"
	"github.com/apache/rocketmq-client-go/v2/primitive"
)

func consumeMessageIDs(message *admin.MessageExt, requested string) []string {
	ids := make([]string, 0, 3)
	seen := map[string]struct{}{}
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if message != nil {
		add(message.OffsetMsgId)
		add(message.MsgId)
	}
	add(requested)
	return ids
}

func normalizeBrokerAddr(host string) string {
	host = strings.TrimSpace(host)
	if host == "" {
		return ""
	}
	if strings.Contains(host, ":") {
		return host
	}
	if i := strings.LastIndex(host, "/"); i > 0 && i < len(host)-1 {
		return host[:i] + ":" + host[i+1:]
	}
	return host
}

func uniqueAddrs(addrs []string) []string {
	out := make([]string, 0, len(addrs))
	seen := map[string]struct{}{}
	for _, addr := range addrs {
		addr = normalizeBrokerAddr(addr)
		if addr == "" {
			continue
		}
		if _, ok := seen[addr]; ok {
			continue
		}
		seen[addr] = struct{}{}
		out = append(out, addr)
	}
	return out
}

func addrFromOffsetMsgID(messageID string) string {
	messageID = strings.TrimSpace(messageID)
	if len(messageID) < 32 {
		return ""
	}
	if _, err := hex.DecodeString(messageID[:32]); err != nil {
		return ""
	}
	if parsed, err := primitive.UnmarshalMsgID([]byte(messageID[:32])); err != nil || parsed == nil || parsed.Addr == "" || parsed.Port <= 0 {
		return ""
	} else if ip := net.ParseIP(parsed.Addr); ip != nil && ip.IsLoopback() {
		return ""
	} else {
		return net.JoinHostPort(parsed.Addr, strconv.Itoa(parsed.Port))
	}
}

func hostIsLoopback(addr string) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		host = strings.TrimSpace(addr)
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func dropUnreachableBrokerAddrs(addrs []string) []string {
	out := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		if hostIsLoopback(addr) {
			continue
		}
		out = append(out, addr)
	}
	return out
}

func brokerAddrsForMessage(ctx context.Context, client *admin.Client, message *admin.MessageExt) []string {
	var addrs []string
	if message != nil {
		addrs = append(addrs, message.StoreHost, addrFromOffsetMsgID(message.OffsetMsgId), addrFromOffsetMsgID(message.MsgId))
		topic := strings.TrimSpace(message.Topic)
		if topic != "" {
			if route, err := client.ExamineTopicRouteInfo(ctx, topic); err == nil && route != nil {
				for _, broker := range route.BrokerDatas {
					if broker == nil {
						continue
					}
					for _, addr := range broker.BrokerAddrs {
						addrs = append(addrs, addr)
					}
				}
			}
		}
	}
	return uniqueAddrs(addrs)
}

func pickOnlineClientIDOnAddrs(ctx context.Context, timeout time.Duration, addrs []string, group string) (string, error) {
	var lastErr error
	for _, addr := range addrs {
		id, err := consumerClientIDAt(ctx, timeout, addr, group)
		if err == nil && id != "" {
			return id, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return "", lastErr
	}
	return "", fmt.Errorf("消费者组 %s 没有在线客户端", group)
}

func consumerClientIDAt(ctx context.Context, timeout time.Duration, addr, group string) (string, error) {
	pool := remoting.NewConnectionPool(timeout)
	defer pool.Close()
	conn, err := pool.GetOrCreate(addr)
	if err != nil {
		return "", err
	}
	cmd := remoting.NewRequest(remoting.GetConsumerConnectionList, map[string]string{
		"consumerGroup": group,
	})
	resp, err := conn.InvokeSync(ctx, cmd)
	if err != nil {
		return "", err
	}
	if resp.Code == remoting.ConsumerNotOnline {
		return "", fmt.Errorf("消费者组 %s 没有在线客户端", group)
	}
	if resp.Code != remoting.Success {
		remark := strings.TrimSpace(resp.Remark)
		if remark == "" {
			remark = fmt.Sprintf("broker 返回码 %d", resp.Code)
		}
		return "", fmt.Errorf("%s", remark)
	}
	var connInfo admin.ConsumerConnection
	if len(resp.Body) > 0 {
		if err := json.Unmarshal(resp.Body, &connInfo); err != nil {
			return "", fmt.Errorf("解析消费者连接失败: %w", err)
		}
	}
	for _, item := range connInfo.ConnectionSet {
		if item == nil {
			continue
		}
		if id := strings.TrimSpace(item.ClientId); id != "" {
			return id, nil
		}
	}
	return "", fmt.Errorf("消费者组 %s 没有在线客户端", group)
}

func consumeOnAddrs(
	ctx context.Context,
	timeout time.Duration,
	addrs []string,
	group, clientID, topic string,
	message *admin.MessageExt,
	requestedID string,
) error {
	ids := consumeMessageIDs(message, requestedID)
	if len(ids) == 0 {
		return fmt.Errorf("消息 ID 为空")
	}
	var lastErr error
	for _, addr := range addrs {
		for _, id := range ids {
			_, err := consumeDirectlyAt(ctx, addr, timeout, group, clientID, topic, id)
			if err == nil {
				return nil
			}
			lastErr = err
		}
	}
	if lastErr != nil {
		return lastErr
	}
	return fmt.Errorf("消费消息失败")
}

func pickConsumerGroup(ctx context.Context, client *admin.Client, topic, requested string) (string, error) {
	if group := strings.TrimSpace(requested); group != "" {
		return group, nil
	}
	if group := consumerGroupFromInternalTopic(topic); group != "" {
		return group, nil
	}
	groups, err := client.QueryTopicConsumeByWho(ctx, topic)
	if err != nil {
		return "", fmt.Errorf("查询消费者组失败: %w", err)
	}
	for _, group := range groups {
		group = strings.TrimSpace(group)
		if group == "" || resource.IsSystemGroup(group) {
			continue
		}
		return group, nil
	}
	return "", fmt.Errorf("没有可用的消费者组，普通 Topic 无法物理删除单条消息；请在死信/重试页删除，或传入在线消费者组")
}

func pickOnlineClientID(ctx context.Context, client *admin.Client, group string) (string, error) {
	conn, err := client.ExamineConsumerConnectionInfo(ctx, group)
	if err != nil {
		return "", fmt.Errorf("消费者组 %s 没有在线客户端: %w", group, err)
	}
	if conn == nil {
		return "", fmt.Errorf("消费者组 %s 没有在线客户端", group)
	}
	for _, item := range conn.ConnectionSet {
		if item == nil {
			continue
		}
		if id := strings.TrimSpace(item.ClientId); id != "" {
			return id, nil
		}
	}
	return "", fmt.Errorf("消费者组 %s 没有在线客户端", group)
}

func consumeDirectlySucceeded(result *admin.ConsumeMessageDirectlyResult) bool {
	if result == nil {
		return false
	}
	status := strings.ToUpper(strings.TrimSpace(result.ConsumeResult))
	if status == "" || strings.Contains(status, "SUCCESS") {
		return true
	}
	return false
}

func consumeDirectlyAt(
	ctx context.Context,
	addr string,
	timeout time.Duration,
	group, clientID, topic, msgID string,
) (*admin.ConsumeMessageDirectlyResult, error) {
	pool := remoting.NewConnectionPool(timeout)
	defer pool.Close()
	conn, err := pool.GetOrCreate(addr)
	if err != nil {
		return nil, err
	}
	cmd := remoting.NewRequest(remoting.ConsumeMessageDirectly, map[string]string{
		"consumerGroup": group,
		"clientId":      clientID,
		"topic":         topic,
		"msgId":         msgID,
	})
	resp, err := conn.InvokeSync(ctx, cmd)
	if err != nil {
		return nil, err
	}
	if resp.Code != remoting.Success {
		remark := strings.TrimSpace(resp.Remark)
		if remark == "" {
			remark = fmt.Sprintf("broker 返回码 %d", resp.Code)
		}
		return nil, fmt.Errorf("%s", remark)
	}
	var result admin.ConsumeMessageDirectlyResult
	if len(resp.Body) > 0 {
		if err := json.Unmarshal(resp.Body, &result); err != nil {
			return nil, fmt.Errorf("解析直接消费结果失败: %w", err)
		}
	}
	if !consumeDirectlySucceeded(&result) {
		detail := strings.TrimSpace(result.ConsumeResult)
		if remark := strings.TrimSpace(result.Remark); remark != "" {
			if detail != "" {
				detail += ": " + remark
			} else {
				detail = remark
			}
		}
		if detail == "" {
			detail = "消费者未确认成功"
		}
		return &result, fmt.Errorf("%s", detail)
	}
	return &result, nil
}

func consumeMessageDirectly(
	ctx context.Context,
	client *admin.Client,
	timeout time.Duration,
	group, clientID, topic string,
	message *admin.MessageExt,
	requestedID string,
) error {
	ids := consumeMessageIDs(message, requestedID)
	if len(ids) == 0 {
		return fmt.Errorf("消息 ID 为空")
	}
	var lastErr error
	addrs := dropUnreachableBrokerAddrs(brokerAddrsForMessage(ctx, client, message))
	if err := consumeOnAddrs(ctx, timeout, addrs, group, clientID, topic, message, requestedID); err == nil {
		return nil
	} else {
		lastErr = err
	}
	for _, id := range ids {
		result, err := client.ConsumeMessageDirectly(ctx, group, clientID, topic, id)
		if err != nil {
			lastErr = err
			continue
		}
		if consumeDirectlySucceeded(result) {
			return nil
		}
		detail := strings.TrimSpace(result.ConsumeResult)
		if remark := strings.TrimSpace(result.Remark); remark != "" {
			detail = strings.TrimSpace(detail + " " + remark)
		}
		if detail == "" {
			detail = "消费者未确认成功"
		}
		lastErr = fmt.Errorf("%s", detail)
	}
	if lastErr != nil {
		return lastErr
	}
	return fmt.Errorf("消费消息失败")
}
