package bridge

import (
	"github.com/amigoer/rocket-leaf/internal/model"
	"github.com/amigoer/rocket-leaf/internal/service/message"
)

// MessageService exposes RocketMQ message query and production to the frontend.
type MessageService struct {
	service *message.Service
}

// MessageQuery carries the message search form.
type MessageQuery struct {
	Topic      string `json:"topic"`
	Key        string `json:"key"`
	Tag        string `json:"tag"`
	MaxResults int    `json:"maxResults"`
	StartTime  int64  `json:"startTime"`
	EndTime    int64  `json:"endTime"`
}

// ResendInput identifies a message to push back to a consumer group.
type ResendInput struct {
	ConsumerGroup string `json:"consumerGroup"`
	ClientID      string `json:"clientId"`
	Topic         string `json:"topic"`
	MessageID     string `json:"messageId"`
}

// SendInput carries a produced message.
type SendInput struct {
	Topic      string `json:"topic"`
	Tags       string `json:"tags"`
	Keys       string `json:"keys"`
	Body       string `json:"body"`
	DelayLevel int    `json:"delayLevel"`
}

// DeleteInput identifies a message to skip via ConsumeMessageDirectly.
type DeleteInput struct {
	Topic         string `json:"topic"`
	MessageID     string `json:"messageId"`
	ConsumerGroup string `json:"consumerGroup"`
	StoreHost     string `json:"storeHost"`
}

// defaultMaxResults mirrors the page size the message views request.
const defaultMaxResults = 32

func maxResultsOrDefault(value int) int {
	if value <= 0 {
		return defaultMaxResults
	}
	return value
}

// Query searches a topic by key, tag and time range.
func (s *MessageService) Query(query MessageQuery) ([]*model.MessageItem, error) {
	return s.service.QueryMessages(query.Topic, query.Key, query.Tag,
		maxResultsOrDefault(query.MaxResults), query.StartTime, query.EndTime)
}

// ByID returns a single message by its ID.
func (s *MessageService) ByID(topic string, messageID string) (*model.MessageItem, error) {
	return s.service.QueryMessageByID(topic, messageID)
}

// Track returns the per-group consume status of a message.
func (s *MessageService) Track(topic string, messageID string) ([]*model.MessageTrackItem, error) {
	return s.service.GetMessageTrack(topic, messageID)
}

// DLQ returns the dead letter messages of a consumer group.
func (s *MessageService) DLQ(group string, maxResults int) ([]*model.MessageItem, error) {
	return s.service.QueryDLQMessages(group, maxResultsOrDefault(maxResults), "", "", 0, 0)
}

// Retry returns the retry messages of a consumer group.
func (s *MessageService) Retry(group string, maxResults int) ([]*model.MessageItem, error) {
	return s.service.QueryRetryMessages(group, maxResultsOrDefault(maxResults), "", "", 0, 0)
}

// Resend pushes a message back to a consumer client and returns the new ID.
func (s *MessageService) Resend(input ResendInput) (string, error) {
	return s.service.ResendMessage(input.ConsumerGroup, input.ClientID, input.Topic, input.MessageID)
}

// Send produces a message and returns its ID.
func (s *MessageService) Send(input SendInput) (string, error) {
	return s.service.SendMessage(input.Topic, input.Tags, input.Keys, input.Body, input.DelayLevel)
}

// Delete asks an online consumer to consume the message directly.
// RocketMQ cannot erase a single record from CommitLog; this is the skip path
// used for retry and dead-letter queues.
func (s *MessageService) Delete(input DeleteInput) error {
	return s.service.DeleteMessage(input.Topic, input.MessageID, input.ConsumerGroup, input.StoreHost)
}
