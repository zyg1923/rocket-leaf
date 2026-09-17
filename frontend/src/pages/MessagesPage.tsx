import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react'
import { Search, Copy, X, Send, GitBranch, Check, Trash2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { MessageItem, MessageTrackItem } from '@/api/models'
import { PageHeader } from '@/components/PageHeader'
import { PageBody, PageToolbar } from '@/components/PageLayout'
import { DetailPanel } from '@/components/DetailPanel'
import { SectionLabel } from '@/components/SectionLabel'
import { InfoRow } from '@/components/InfoRow'
import { JsonView } from '@/components/JsonView'
import { useTopics } from '@/hooks/useTopics'
import { useConsumers } from '@/hooks/useConsumers'
import { useRecentPicks } from '@/hooks/useRecentPicks'
import { useSettings } from '@/hooks/useSettings'
import { useDelayedUnmount } from '@/hooks/useDelayedUnmount'
import * as messageApi from '@/api/message'
import { cn, formatErrorMessage } from '@/lib/utils'
import { ROW_FOCUS_CLASS } from '@/lib/a11y'
import {
  detectBodyKind,
  formatMessageTime,
  toHexDump,
  truncatePayload,
  type BodyPreviewKind,
} from '@/lib/time'
import { SlidingTabs } from '@/components/SlidingTabs'
import { UnderlineTabs } from '@/components/UnderlineTabs'
import { EmptyState } from '@/components/EmptyState'
import { OfflineEmpty } from '@/components/OfflineEmpty'
import { ErrorBanner } from '@/components/ErrorBanner'
import type { NavId } from '@/layout/Sidebar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Combobox } from '@/components/ui/combobox'
import { DatePicker } from '@/components/ui/date-picker'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu } from '@/components/ui/context-menu'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Modal } from '@/components/ui/modal'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

type TabKey = 'topic' | 'msgid' | 'retry' | 'dlq'

/** Broker query hard cap in internal/service/message/query.go. */
const QUERY_CAP = 1000

function pageButtons(current: number, total: number): Array<number | 'gap'> {
  if (total <= 0) return []
  if (total <= 9) return Array.from({ length: total }, (_, i) => i + 1)
  const picked = new Set([1, total, current - 2, current - 1, current, current + 1, current + 2])
  const nums = [...picked].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b)
  const out: Array<number | 'gap'> = []
  for (const n of nums) {
    const prev = out[out.length - 1]
    if (typeof prev === 'number' && n - prev > 1) out.push('gap')
    out.push(n)
  }
  return out
}

function tryFormatJSON(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

export function MessagesPage({ onNavigate }: { onNavigate?: (id: NavId) => void }) {
  const { t } = useTranslation()
  const { topics, hasOnline } = useTopics()
  const { groups: consumerGroups } = useConsumers()
  const { settings } = useSettings()
  const { recent: recentTopics, record: recordTopic } = useRecentPicks('topic')
  const { recent: recentGroups, record: recordGroup } = useRecentPicks('group')
  const [tab, setTab] = useState<TabKey>('topic')

  // Form state per tab
  const [topic, setTopic] = useState<string>('')
  const [msgId, setMsgId] = useState<string>('')
  const [keyFilter, setKeyFilter] = useState<string>('')
  const [tagFilter, setTagFilter] = useState<string>('')
  const [beginAt, setBeginAt] = useState<string>('')
  const [endAt, setEndAt] = useState<string>('')
  const [group, setGroup] = useState<string>('')
  const [limit, setLimit] = useState<number>(settings.fetchLimit || 32)

  // Result state
  const [results, setResults] = useState<MessageItem[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const searchRequestRef = useRef(0)
  const skippedIdsRef = useRef(new Set<string>())

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [resendTarget, setResendTarget] = useState<MessageItem | null>(null)
  const [deleteTargets, setDeleteTargets] = useState<MessageItem[] | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [page, setPage] = useState(1)
  const [jumpDraft, setJumpDraft] = useState('1')
  const [capped, setCapped] = useState(false)
  const batchSelectable = true
  const pagingEnabled = tab === 'topic' || tab === 'retry' || tab === 'dlq'
  const pageSize = Math.min(500, Math.max(1, limit))
  const totalPages = Math.max(1, Math.ceil(results.length / pageSize))
  const pageRows = useMemo(() => {
    if (!pagingEnabled) return results
    const start = (page - 1) * pageSize
    return results.slice(start, start + pageSize)
  }, [pagingEnabled, page, pageSize, results])

  useEffect(() => {
    if (results.length === 0) return
    if (page > totalPages) {
      setPage(totalPages)
      setJumpDraft(String(totalPages))
    }
  }, [page, results.length, totalPages])

  const sendableTopics = useMemo(
    () =>
      topics
        .filter((tp) => !tp.topic.startsWith('%RETRY%') && !tp.topic.startsWith('%DLQ%'))
        .map((tp) => tp.topic)
        .sort(),
    [topics],
  )
  const sortedGroups = useMemo(() => consumerGroups.map((g) => g.group).sort(), [consumerGroups])

  const selected = useMemo(
    () => results.find((m) => m.messageId === selectedId) ?? null,
    [results, selectedId],
  )

  // Selection is set inline by handleSearch (and cleared by close).
  // No effect needed — that would cause the close button to re-select instantly.

  const dismissPanel = useCallback(() => setSelectedId(null), [])

  const openDetail = useCallback((id: string) => {
    setSelectedId(id)
    setCheckedIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
    setAnchorId(id)
  }, [])

  const toggleChecked = useCallback((id: string, shift: boolean, ctrl: boolean) => {
    const ids = pageRows.map((m) => m.messageId)
    if (shift && anchorId) {
      const a = ids.indexOf(anchorId)
      const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setCheckedIds(new Set(ids.slice(lo, hi + 1)))
        return
      }
    }
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (ctrl) {
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setAnchorId(id)
  }, [anchorId, pageRows])

  const panelMount = useDelayedUnmount(!!selected)
  // Pin the displayed item so it stays alive during the exit animation.
  const [pinnedSelected, setPinnedSelected] = useState<MessageItem | null>(null)
  useEffect(() => {
    if (selected) setPinnedSelected(selected)
  }, [selected])
  const renderedSelected = selected ?? pinnedSelected

  // Esc closes the detail panel
  useEffect(() => {
    if (!selectedId) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissPanel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedId, dismissPanel])

  // Clicking the result pane outside any row closes the panel
  const handleListBackgroundClick = (e: MouseEvent) => {
    if (!selectedId) return
    if ((e.target as HTMLElement).closest('tr')) return
    dismissPanel()
  }

  const queryRange = () => {
    const beginMs = beginAt ? new Date(beginAt).getTime() : 0
    const userEndMs = endAt ? new Date(endAt).getTime() : 0
    if (
      (beginAt && Number.isNaN(beginMs)) ||
      (endAt && Number.isNaN(userEndMs)) ||
      (beginMs > 0 && userEndMs > 0 && beginMs > userEndMs)
    ) {
      throw new Error(t('messages.form.validateTimeRange'))
    }
    const condition = {
      messageKey: keyFilter,
      messageTag: tagFilter,
      startTimeMs: beginMs,
      endTimeMs: userEndMs,
    }
    if (tab === 'topic') {
      return messageApi.queryMessagesByCondition(topic, condition, QUERY_CAP)
    }
    if (tab === 'retry') {
      return messageApi.queryMessagesByCondition(`%RETRY%${group}`, condition, QUERY_CAP)
    }
    return messageApi.queryMessagesByCondition(`%DLQ%${group}`, condition, QUERY_CAP)
  }

  const runQuery = async () => {
    const requestId = ++searchRequestRef.current
    setError(null)
    setHasSearched(true)
    if (tab === 'topic' || tab === 'msgid') {
      if (!topic) {
        setError(t('messages.form.validateTopic'))
        return
      }
      if (tab === 'msgid' && !msgId.trim()) {
        setError(t('messages.form.validateMsgId'))
        return
      }
    } else if (!group) {
      setError(t('messages.form.validateGroup'))
      return
    }
    setSearching(true)
    try {
      let next: MessageItem[] = []
      if (tab === 'msgid') {
        next = await messageApi.queryMessagesByCondition(topic, { messageId: msgId.trim() })
      } else {
        next = await queryRange()
      }
      if (requestId !== searchRequestRef.current) return
      if (tab === 'topic' || tab === 'msgid') recordTopic(topic)
      else recordGroup(group)
      setResults(next.filter((m) => !skippedIdsRef.current.has(m.messageId)))
      setPage(1)
      setJumpDraft('1')
      setCapped(pagingEnabled && next.length >= QUERY_CAP)
      setSelectedId(null)
      setCheckedIds(new Set())
      setAnchorId(null)
      if (next.length === 0) {
        toast.info(t('messages.empty'))
      }
    } catch (e) {
      if (requestId !== searchRequestRef.current) return
      const msg = e instanceof Error && e.message === t('messages.form.validateTimeRange')
        ? e.message
        : formatErrorMessage(e)
      setError(msg)
      if (msg !== t('messages.form.validateTimeRange')) {
        toast.error(t('messages.queryError', { message: msg }))
      }
    } finally {
      if (requestId === searchRequestRef.current) setSearching(false)
    }
  }

  const goToPage = (next: number) => {
    const pages = Math.max(1, Math.ceil(results.length / pageSize))
    const clamped = Math.min(pages, Math.max(1, Math.trunc(next) || 1))
    setPage(clamped)
    setJumpDraft(String(clamped))
    setCheckedIds(new Set())
    setAnchorId(null)
  }

  const handleSearch = () => {
    void runQuery()
  }

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('messages.detail.copySuccess'))
    } catch {
      toast.error(t('messages.detail.copyError'))
    }
  }

  const allChecked = pageRows.length > 0 && pageRows.every((m) => checkedIds.has(m.messageId))
  const someChecked = pageRows.some((m) => checkedIds.has(m.messageId))

  const handleClearResults = () => {
    setResults([])
    setHasSearched(false)
    setSelectedId(null)
    setCheckedIds(new Set())
    setAnchorId(null)
    setPage(1)
    setJumpDraft('1')
    setCapped(false)
  }

  const removeFromResults = (ids: string[]) => {
    const drop = new Set(ids)
    setResults((prev) => prev.filter((m) => !drop.has(m.messageId)))
    setCheckedIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })
    if (selectedId && drop.has(selectedId)) setSelectedId(null)
  }

  const deleteGroupFor = (msg: MessageItem) => {
    if (msg.topic.startsWith('%DLQ%')) return msg.topic.slice(5)
    if (msg.topic.startsWith('%RETRY%')) return msg.topic.slice(7)
    return group.trim()
  }

  const handleConfirmDelete = async () => {
    const targets = deleteTargets
    if (!targets || targets.length === 0) return
    setBatchBusy(true)
    let ok = 0
    let fail = 0
    let lastError = ''
    const removed: string[] = []
    for (const msg of targets) {
      try {
        await messageApi.deleteMessage(msg.topic, msg.messageId, deleteGroupFor(msg), msg.storeHost)
        ok += 1
        removed.push(msg.messageId)
        skippedIdsRef.current.add(msg.messageId)
      } catch (e) {
        fail += 1
        lastError = formatErrorMessage(e)
      }
    }
    removeFromResults(removed)
    setBatchBusy(false)
    setDeleteTargets(null)
    if (fail === 0) {
      toast.success(
        targets.length === 1
          ? t('messages.detail.deleteSuccess')
          : t('messages.batchDeleteSuccess', { count: ok }),
      )
    } else {
      toast.error(t('messages.batchDeletePartial', { ok, fail }), {
        description: lastError || undefined,
      })
    }
  }

  const handleBatchResend = async () => {
    const targets = results.filter((m) => checkedIds.has(m.messageId))
    if (targets.length === 0) return
    setBatchBusy(true)
    let ok = 0
    let fail = 0
    for (const msg of targets) {
      try {
        await messageApi.resendMessage('', '', msg.topic, msg.messageId)
        ok += 1
      } catch {
        fail += 1
      }
    }
    setBatchBusy(false)
    if (fail === 0) toast.success(t('messages.batchResendSuccess', { count: ok }))
    else toast.error(t('messages.batchResendPartial', { ok, fail }))
  }

  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLElement>, id: string) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      openDetail(id)
      return
    }
    if (event.key === ' ') {
      event.preventDefault()
      toggleChecked(id, event.shiftKey, event.ctrlKey || event.metaKey)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={t('messages.title')}
        subtitle={!hasOnline ? t('messages.subtitleNoConn') : undefined}
      />

      {hasOnline && (
        <PageToolbar>
          <SlidingTabs
            value={tab}
            onChange={(key) => {
              searchRequestRef.current += 1
              setTab(key)
              setResults([])
              setError(null)
              setHasSearched(false)
              setSelectedId(null)
              setCheckedIds(new Set())
              setAnchorId(null)
              setPage(1)
              setJumpDraft('1')
              setCapped(false)
            }}
            items={[
              { key: 'topic', label: t('messages.tabs.topic') },
              { key: 'msgid', label: t('messages.tabs.msgid') },
              { key: 'retry', label: t('messages.tabs.retry') },
              { key: 'dlq', label: t('messages.tabs.dlq') },
            ]}
          />
        </PageToolbar>
      )}

      {!hasOnline ? (
        <OfflineEmpty
          message={t('messages.subtitleNoConn')}
          className="flex-1"
          onAction={() => onNavigate?.('connections')}
        />
      ) : (
        <>
          {/* Query bar */}
          <div className="mx-5 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border/80 bg-card p-3 shadow-card">
            {(tab === 'topic' || tab === 'msgid') && (
              <Combobox
                className="font-mono-design"
                style={{ width: '16.92rem' }}
                value={topic}
                onChange={setTopic}
                options={sendableTopics}
                recent={recentTopics}
                searchable={false}
                clearable={false}
                emptyLabel={t('messages.form.topicPlaceholder')}
                searchPlaceholder={t('messages.form.topicSearchPlaceholder')}
                recentLabel={t('common.recentUsed')}
                allLabel={t('common.all')}
                emptyMessage={t('common.noMatch')}
                moreHint={(count) => t('common.moreResults', { count })}
                aria-label={t('messages.form.topic')}
              />
            )}
            {(tab === 'retry' || tab === 'dlq') && (
              <Combobox
                className="font-mono-design"
                style={{ width: '18.46rem' }}
                value={group}
                onChange={setGroup}
                options={sortedGroups}
                recent={recentGroups}
                searchable={false}
                clearable={false}
                emptyLabel={t('messages.form.groupPlaceholder')}
                searchPlaceholder={t('messages.form.groupSearchPlaceholder')}
                recentLabel={t('common.recentUsed')}
                allLabel={t('common.all')}
                emptyMessage={t('common.noMatch')}
                moreHint={(count) => t('common.moreResults', { count })}
                aria-label={t('messages.form.group')}
              />
            )}

            {(tab === 'topic' || tab === 'retry' || tab === 'dlq') && (
              <>
                <DatePicker
                  className="font-mono-design"
                  placeholder={t('messages.form.begin')}
                  style={{ width: '15.38rem' }}
                  value={beginAt}
                  onChange={setBeginAt}
                  title={t('messages.form.begin')}
                />
                <DatePicker
                  className="font-mono-design"
                  placeholder={t('messages.form.end')}
                  style={{ width: '15.38rem' }}
                  value={endAt}
                  onChange={setEndAt}
                  title={t('messages.form.end')}
                />
                <Input
                  placeholder={t('messages.form.key')}
                  style={{ width: '10.77rem' }}
                  value={keyFilter}
                  onChange={(e) => setKeyFilter(e.target.value)}
                />
                <Input
                  placeholder={t('messages.form.tag')}
                  style={{ width: '9.23rem' }}
                  value={tagFilter}
                  onChange={(e) => setTagFilter(e.target.value)}
                />
              </>
            )}
            {tab === 'msgid' && (
              <Input
                className="font-mono-design"
                placeholder={t('messages.form.msgIdPlaceholder')}
                style={{ flex: 1, minWidth: '18.46rem' }}
                value={msgId}
                onChange={(e) => setMsgId(e.target.value)}
              />
            )}
            {(tab === 'topic' || tab === 'retry' || tab === 'dlq') && (
              <Input
                type="number"
                min={1}
                max={500}
                style={{ width: '6.92rem' }}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value) || 32)}
                title={t('messages.form.limit')}
              />
            )}
            <Button variant="default" size="sm"
              onClick={handleSearch}
              disabled={searching}
            >
              {searching ? <Spinner size={13} /> : <Search size={13} />}
              {searching ? t('messages.form.searching') : t('messages.form.search')}
            </Button>
          </div>

          {hasSearched && !searching && (
            <div className="mx-5 mt-2 flex shrink-0 flex-wrap items-center gap-2">
              {results.length > 0 && (
                <div className="text-muted-foreground text-fs-12">
                  {pagingEnabled
                    ? t('messages.pageTotal', { count: results.length, pages: totalPages })
                    : t('messages.summary', { count: results.length })}
                  {capped ? ` · ${t('messages.pageCapped', { cap: QUERY_CAP })}` : ''}
                  {checkedIds.size > 0 ? ` · ${t('messages.selected', { count: checkedIds.size })}` : ''}
                </div>
              )}
              {checkedIds.size > 0 && (
                <Button variant="outline" size="sm" onClick={handleBatchResend} disabled={batchBusy}>
                  {batchBusy ? <Spinner size={13} /> : <Send size={13} />}
                  {t('messages.batchResend')}
                </Button>
              )}
              {checkedIds.size > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  onClick={() =>
                    setDeleteTargets(results.filter((m) => checkedIds.has(m.messageId)))
                  }
                  disabled={batchBusy}
                >
                  <Trash2 size={13} />
                  {t('messages.batchDelete')}
                </Button>
              )}
              {pagingEnabled && results.length > 0 && (
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t('messages.pageFirst')}
                    onClick={() => goToPage(1)}
                    disabled={page <= 1}
                  >
                    <ChevronsLeft size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t('messages.pagePrev')}
                    onClick={() => goToPage(page - 1)}
                    disabled={page <= 1}
                  >
                    <ChevronLeft size={13} />
                    {t('messages.pagePrev')}
                  </Button>
                  <span className="text-muted-foreground px-1 text-fs-12 tabular-nums">
                    {t('messages.pageInfo', { page, pages: totalPages })}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t('messages.pageNext')}
                    onClick={() => goToPage(page + 1)}
                    disabled={page >= totalPages}
                  >
                    {t('messages.pageNext')}
                    <ChevronRight size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t('messages.pageLast')}
                    onClick={() => goToPage(totalPages)}
                    disabled={page >= totalPages}
                  >
                    <ChevronsRight size={13} />
                  </Button>
                  <Input
                    type="number"
                    min={1}
                    max={totalPages}
                    aria-label={t('messages.pageJumpTo')}
                    style={{ width: '4.2rem' }}
                    value={jumpDraft}
                    onChange={(e) => setJumpDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') goToPage(Number(jumpDraft))
                    }}
                  />
                  <Button variant="outline" size="sm" onClick={() => goToPage(Number(jumpDraft))}>
                    {t('messages.pageJump')}
                  </Button>
                  <Popover.Root>
                    <Popover.Trigger asChild>
                      <Button variant="outline" size="sm">{t('messages.pageQuick')}</Button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content
                        align="end"
                        sideOffset={6}
                        className="z-50 w-[16.5rem] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-[0_12px_40px_hsl(0_0%_0%/0.12)]"
                      >
                        <div className="text-muted-foreground mb-2 text-fs-12">
                          {t('messages.pageTotal', { count: results.length, pages: totalPages })}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {pageButtons(page, totalPages).map((item, i) =>
                            item === 'gap' ? (
                              <span key={`gap-${i}`} className="text-muted-foreground px-1 py-1 text-fs-12">
                                …
                              </span>
                            ) : (
                              <Button
                                key={item}
                                type="button"
                                size="sm"
                                variant={item === page ? 'default' : 'outline'}
                                className="h-7 min-w-7 px-2"
                                onClick={() => goToPage(item)}
                              >
                                {item}
                              </Button>
                            ),
                          )}
                        </div>
                        <div className="mt-2 flex items-center gap-1">
                          <Input
                            type="number"
                            min={1}
                            max={totalPages}
                            style={{ width: '5rem' }}
                            value={jumpDraft}
                            onChange={(e) => setJumpDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') goToPage(Number(jumpDraft))
                            }}
                          />
                          <Button size="sm" onClick={() => goToPage(Number(jumpDraft))}>
                            {t('messages.pageJump')}
                          </Button>
                        </div>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                </div>
              )}
              <Button variant="ghost" size="sm" onClick={handleClearResults}>
                {t('messages.clearResults')}
              </Button>
            </div>
          )}

          {error && <ErrorBanner message={error} />}

          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            <PageBody onClick={handleListBackgroundClick}>
              {searching && results.length === 0 ? (
                <div
                  className="text-muted-foreground flex items-center justify-center"
                  style={{ padding: 60, gap: 8 }}
                >
                  <Spinner size={14} />
                  <span className="text-fs-12">{t('messages.form.searching')}</span>
                </div>
              ) : !hasSearched ? (
                <EmptyState
                  icon={Search}
                  title={t('messages.emptyPromptTitle')}
                  description={t('messages.emptyPromptHint')}
                />
              ) : results.length === 0 ? (
                <EmptyState icon={Search} title={t('messages.empty')} />
              ) : (
                <Card className="overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="select-none">
                      {batchSelectable && (
                        <TableHead style={{ width: '2.4rem' }}>
                          <Checkbox
                            aria-label={t('messages.selected', { count: checkedIds.size })}
                            checked={allChecked}
                            indeterminate={!allChecked && someChecked}
                            onCheckedChange={(next) => {
                              if (next) setCheckedIds(new Set(pageRows.map((m) => m.messageId)))
                              else setCheckedIds(new Set())
                            }}
                          />
                        </TableHead>
                      )}
                      <TableHead style={{ width: '8.46rem' }}>{t('messages.table.tag')}</TableHead>
                      <TableHead style={{ width: '13.85rem' }}>{t('messages.table.key')}</TableHead>
                      <TableHead>{t('messages.table.preview')}</TableHead>
                      <TableHead style={{ width: '5.38rem', textAlign: 'right' }}>{t('messages.table.queue')}</TableHead>
                      <TableHead style={{ width: '13.08rem' }}>{t('messages.table.storeTime')}</TableHead>
                      <TableHead style={{ width: '15.38rem' }}>{t('messages.table.msgId')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((m) => {
                      const checked = checkedIds.has(m.messageId)
                      const isDetail = selectedId === m.messageId
                      const row = (
                        <TableRow
                          key={m.messageId}
                          data-state={checked || isDetail ? 'selected' : undefined}
                          aria-selected={checked || isDetail}
                          className={cn(ROW_FOCUS_CLASS, 'select-none')}
                          tabIndex={0}
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest('[role="checkbox"]')) return
                            toggleChecked(m.messageId, e.shiftKey, e.ctrlKey || e.metaKey)
                          }}
                          onDoubleClick={() => openDetail(m.messageId)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            openDetail(m.messageId)
                          }}
                          onKeyDown={(e) => handleRowKeyDown(e, m.messageId)}
                          style={{ cursor: 'pointer' }}
                        >
                          {batchSelectable && (
                            <TableCell>
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() =>
                                  toggleChecked(m.messageId, false, true)
                                }
                              />
                            </TableCell>
                          )}
                          <TableCell>
                            {m.tags ? (
                              <Badge variant="outline">{m.tags}</Badge>
                            ) : (
                              <span className="text-muted-foreground text-fs-12">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="font-mono-design text-fs-12">{m.keys || '—'}</span>
                          </TableCell>
                          <TableCell>
                            <div
                              className="font-mono-design text-muted-foreground text-fs-12"
                              style={{
                                maxWidth: '21.54rem',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {m.body}
                            </div>
                          </TableCell>
                          <TableCell style={{ textAlign: 'right' }} className="tabular-nums text-muted-foreground">
                            {m.queueId}
                          </TableCell>
                          <TableCell className="font-mono-design text-muted-foreground text-fs-12">
                            {formatMessageTime(
                              m.storeTimestamp || m.storeTime,
                              settings.timezone,
                              settings.timestampFormat,
                            )}
                          </TableCell>
                          <TableCell>
                            <div
                              className="font-mono-design truncate text-fs-12"
                              style={{ maxWidth: '13.85rem' }}
                              title={m.messageId}
                            >
                              {m.messageId.slice(0, 24)}…
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                      return (
                        <ContextMenu
                          key={m.messageId}
                          items={[
                            { label: t('messages.openDetail'), onSelect: () => openDetail(m.messageId) },
                            {
                              label: t('messages.detail.actions.resend'),
                              onSelect: () => {
                                openDetail(m.messageId)
                                setResendTarget(m)
                              },
                            },
                            {
                              label: t('messages.detail.actions.delete'),
                              onSelect: () => setDeleteTargets([m]),
                            },
                          ]}
                        >
                          {row}
                        </ContextMenu>
                      )
                    })}
                  </TableBody>
                </Table>
                </Card>
              )}
            </PageBody>

            {panelMount.shouldRender && renderedSelected && (
              <div className="absolute inset-y-0 right-0 z-10 h-full min-h-0 overflow-hidden shadow-[-12px_0_28px_hsl(0_0%_0%/0.12)]">
                <MessageDetailPanel
                  msg={renderedSelected}
                  exiting={panelMount.exiting}
                  onClose={dismissPanel}
                  onCopy={handleCopy}
                  onResend={() => setResendTarget(renderedSelected)}
                  onDelete={() => setDeleteTargets([renderedSelected])}
                />
              </div>
            )}
          </div>
        </>
      )}

      {resendTarget && <ResendDialog msg={resendTarget} onClose={() => setResendTarget(null)} />}
      <ConfirmDialog
        open={deleteTargets != null}
        title={
          (deleteTargets?.length ?? 0) > 1
            ? t('messages.batchDelete')
            : t('messages.detail.deleteTitle')
        }
        description={
          (deleteTargets?.length ?? 0) > 1
            ? t('messages.batchDeleteConfirm', { count: deleteTargets?.length ?? 0 })
            : t('messages.detail.deleteConfirm')
        }
        confirmText={batchBusy ? t('common.loading') : t('common.delete')}
        cancelText={t('common.cancel')}
        variant="destructive"
        onConfirm={handleConfirmDelete}
        onCancel={() => !batchBusy && setDeleteTargets(null)}
      />
    </div>
  )
}

// ---------- Detail Panel ----------

function MessageDetailPanel({
  msg,
  exiting,
  onClose,
  onCopy,
  onResend,
  onDelete,
}: {
  msg: MessageItem
  exiting: boolean
  onClose: () => void
  onCopy: (s: string) => void
  onResend: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const { settings } = useSettings()
  const [tab, setTab] = useState<'body' | 'properties' | 'track'>('body')
  const [bodyMode, setBodyMode] = useState<'auto' | 'raw' | 'hex'>('auto')
  const [track, setTrack] = useState<MessageTrackItem[] | null>(null)
  const [trackLoading, setTrackLoading] = useState(false)
  const [trackError, setTrackError] = useState<string | null>(null)

  // Reset to body tab when message changes
  useEffect(() => {
    setTab('body')
    setBodyMode('auto')
    setTrack(null)
    setTrackError(null)
  }, [msg.messageId])

  // Lazy-load track when track tab opens
  useEffect(() => {
    if (tab !== 'track' || track) return
    let cancelled = false
    setTrackLoading(true)
    setTrackError(null)
    messageApi
      .getMessageTrack(msg.topic, msg.messageId)
      .then((data) => {
        if (!cancelled) setTrack(data)
      })
      .catch((e) => {
        if (!cancelled) setTrackError(formatErrorMessage(e))
      })
      .finally(() => {
        if (!cancelled) setTrackLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, track, msg.messageId, msg.topic])

  const payload = truncatePayload(msg.body || '', settings.maxPayloadRenderBytes || 512 * 1024)
  const detectedKind: BodyPreviewKind = detectBodyKind(payload.text)
  const displayBody = (() => {
    if (bodyMode === 'hex' || (bodyMode === 'auto' && detectedKind === 'binary')) {
      return toHexDump(payload.text)
    }
    if (bodyMode === 'auto' && detectedKind === 'json' && settings.autoFormatJson !== false) {
      return tryFormatJSON(payload.text)
    }
    if (bodyMode === 'auto' && settings.autoFormatJson !== false) {
      return tryFormatJSON(payload.text)
    }
    return payload.text
  })()
  const displayStoreTime = formatMessageTime(
    msg.storeTimestamp || msg.storeTime,
    settings.timezone,
    settings.timestampFormat,
  )

  const propEntries = Object.entries(msg.properties || {}).filter(
    ([, v]) => v !== undefined && v !== '',
  )

  return (
    <DetailPanel
      exiting={exiting}
      layout="column"
      ariaLabel={t('messages.detail.title')}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-5 py-4">
        <div className="truncate font-semibold">{t('messages.detail.title')}</div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="icon-sm"
            onClick={() => onCopy(msg.messageId)}
            title={t('messages.detail.actions.copyId')}
          >
            <Copy size={13} />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>
      </div>

      <UnderlineTabs
        bleed
        className="shrink-0 px-5"
        value={tab}
        onChange={setTab}
        items={(['body', 'properties', 'track'] as const).map((k) => ({
          key: k,
          label: t(`messages.detail.tabs.${k}`),
        }))}
      />

      <div className="scroll-thin min-h-0 flex-1 overflow-auto px-5 py-4">
        <SectionLabel first>{t('messages.detail.info')}</SectionLabel>
        <div>
          <InfoRow label={t('messages.detail.topic')} mono>{msg.topic}</InfoRow>
          {msg.tags && (
            <InfoRow label={t('messages.detail.tag')}>{msg.tags}</InfoRow>
          )}
          {msg.keys && (
            <InfoRow label={t('messages.detail.key')} mono>{msg.keys}</InfoRow>
          )}
          <InfoRow label={t('messages.detail.queue')} valueClassName="tabular-nums">{msg.queueId}</InfoRow>
          <InfoRow label={t('messages.detail.queueOffset')} valueClassName="tabular-nums">{msg.queueOffset}</InfoRow>
          {msg.bornHost && (
            <InfoRow label={t('messages.detail.bornHost')} mono>{msg.bornHost}</InfoRow>
          )}
          {msg.storeHost && (
            <InfoRow label={t('messages.detail.storeHost')} mono>{msg.storeHost}</InfoRow>
          )}
          <InfoRow label={t('messages.detail.storeTime')} mono>{displayStoreTime}</InfoRow>
          {msg.status && (
            <InfoRow label={t('messages.detail.status')}>{msg.status}</InfoRow>
          )}
          {msg.retryTimes > 0 && (
            <InfoRow label={t('messages.detail.retryTimes')} valueClassName="tabular-nums">{msg.retryTimes}</InfoRow>
          )}
          <InfoRow label={t('messages.detail.msgId')} mono valueClassName="break-all">{msg.messageId}</InfoRow>
        </div>

        {tab === 'body' && (
          <>
            <div
              className="mb-2 mt-5 flex items-center justify-between gap-2"
              style={{ marginTop: 20 }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <SectionLabel first className="mb-0">{t('messages.detail.bodyTitle')}</SectionLabel>
                <Badge variant="outline" className="text-fs-10">
                  {t(`messages.detail.bodyKind.${detectedKind}`)}
                </Badge>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {(['auto', 'raw', 'hex'] as const).map((mode) => (
                  <Button
                    key={mode}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={
                      'h-6 px-1.5 text-fs-11 ' +
                      (bodyMode === mode ? 'text-foreground' : 'text-muted-foreground')
                    }
                    onClick={() => setBodyMode(mode)}
                  >
                    {t(`messages.detail.bodyMode.${mode}`)}
                  </Button>
                ))}
                <Button variant="ghost" size="sm" onClick={() => onCopy(msg.body)}>
                  <Copy size={12} />
                  {t('messages.detail.actions.copyBody')}
                </Button>
              </div>
            </div>
            {payload.truncated && (
              <div className="text-muted-foreground mb-2 text-fs-11" style={{ lineHeight: 1.5 }}>
                {t('messages.detail.bodyTruncated', {
                  shown: Math.round(settings.maxPayloadRenderBytes / 1024),
                  total: Math.round(payload.originalBytes / 1024),
                })}
              </div>
            )}
            <JsonView src={displayBody} maxHeight={300} />
          </>
        )}

        {tab === 'properties' && (
          <div className="mt-4">
            {propEntries.length === 0 ? (
              <EmptyState compact title={t('messages.detail.propsEmpty')} />
            ) : (
              <div>
                {propEntries.map(([k, v]) => (
                  <InfoRow key={k} label={<span className="font-mono-design">{k}</span>} mono valueClassName="break-all">{String(v)}</InfoRow>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'track' && (
          <div className="mt-4">
            <SectionLabel>{t('messages.detail.trackTitle')}</SectionLabel>
            {trackLoading ? (
              <div
                className="text-muted-foreground flex items-center justify-center"
                style={{ padding: 24, gap: 8 }}
              >
                <Spinner size={14} />
                <span className="text-fs-12">{t('messages.detail.trackLoading')}</span>
              </div>
            ) : trackError ? (
              <div
                className="text-fs-12"
                style={{ padding: 16, color: 'hsl(var(--destructive))' }}
              >
                {t('messages.detail.trackError')}: {trackError}
              </div>
            ) : !track || track.length === 0 ? (
              <EmptyState compact title={t('messages.detail.trackEmpty')} />
            ) : (
              <Card className="overflow-hidden">
                {track.map((tr, i) => (
                  <div
                    key={`${tr.consumerGroup}-${i}`}
                    style={{
                      padding: '10px 14px',
                      borderTop: i ? '1px solid hsl(var(--border))' : undefined,
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <GitBranch size={11} className="text-muted-foreground" />
                      <span className="font-mono-design flex-1 text-fs-12">
                        {tr.consumerGroup}
                      </span>
                      {tr.trackType && (
                        <Badge
                          variant={
                            tr.trackType === 'CONSUMED'
                              ? 'success'
                              : tr.trackType === 'NOT_CONSUME_YET'
                                ? 'warning'
                                : 'outline'
                          }
                        >
                          {tr.trackType}
                        </Badge>
                      )}
                    </div>
                    {tr.consumeStatus && (
                      <div className="text-muted-foreground mt-1 text-fs-12">{tr.consumeStatus}</div>
                    )}
                    {tr.exceptionDesc && (
                      <div
                        className="mt-1 text-fs-11"
                        style={{ color: 'hsl(var(--destructive))' }}
                      >
                        {tr.exceptionDesc}
                      </div>
                    )}
                  </div>
                ))}
              </Card>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-2 pb-2">
          <Button variant="outline" size="sm" onClick={onResend}>
            <Send size={13} />
            {t('messages.detail.actions.resend')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setTab('track')}>
            <GitBranch size={13} />
            {t('messages.detail.actions.track')}
          </Button>
          <Button variant="outline" size="sm" className="text-destructive" onClick={onDelete}>
            <Trash2 size={13} />
            {t('messages.detail.actions.delete')}
          </Button>
        </div>
      </div>
    </DetailPanel>
  )
}

// ---------- Resend dialog ----------

function ResendDialog({ msg, onClose }: { msg: MessageItem; onClose: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const targetTopic = msg.properties?.RETRY_TOPIC || msg.properties?.REAL_TOPIC || msg.topic

  const handleResend = async () => {
    setBusy(true)
    try {
      const result = await messageApi.resendMessage('', '', msg.topic, msg.messageId)
      toast.success(t('messages.detail.resendSuccess', { topic: targetTopic }), {
        description: result,
      })
      onClose()
    } catch (e) {
      toast.error(t('messages.detail.resendError'), {
        description: formatErrorMessage(e),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      size="sm"
      title={t('messages.detail.resendTitle')}
      description={t('messages.detail.resendDesc', { topic: targetTopic })}
      dismissible={!busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" size="sm" type="button" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="default" size="sm" type="button" onClick={handleResend} disabled={busy}>
            {busy ? <Spinner size={13} /> : <Check size={13} />}
            {t('messages.detail.resendSubmit')}
          </Button>
        </>
      }
    />
  )
}
