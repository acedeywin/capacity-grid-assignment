import { useEffect, useRef, useState } from 'react'
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query'

type Props = {
  from: string
  to: string
}

export type Person = {
  id: number
  name: string
  weekly_hours: number
  allocated: number[]
}

export type CapacityData = {
  weeks: string[]
  people: Person[]
}

// Query key factory. One place to change the shape; one place to invalidate
// from any future caller. Every range lives under the ['capacity'] prefix so a
// capacity edit can patch all of them at once.
export const capacityKey = (from: string, to: string) =>
  ['capacity', from, to] as const
const capacityPrefix = ['capacity'] as const

async function fetchCapacity(
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<CapacityData> {
  const res = await fetch(`/api/capacity?from=${from}&to=${to}`, { signal })
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`)
  return (await res.json()) as CapacityData
}

async function updateWeeklyHours(
  id: number,
  weekly_hours: number,
): Promise<{ id: number; name: string; weekly_hours: number }> {
  const res = await fetch(`/api/people/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weekly_hours }),
  })
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`)
  return res.json()
}

type SaveVars = { id: number; next: number; prev: number }
type RowError = { message: string; attempted: number }

// CapacityGrid renders one row per person and one column per week, showing
// how allocated each person is and making over-allocation obvious.
//
// Capacity (weekly_hours) is editable from the first data column. Edits are
// optimistic against every cached capacity range, not just the visible one —
// weekly_hours is per person, so a range we navigated away from would
// otherwise come back from cache with the old value. Rollback is per person
// (restore `prev` for that id only), so a failed save can't undo a concurrent
// successful save on another row. We deliberately do NOT refetch after a
// successful save: allocation comes from assignments and does not move.
export function CapacityGrid({ from, to }: Props) {
  const qc = useQueryClient()

  const { data, error, isPending, isError, isPlaceholderData, refetch } =
    useQuery({
      queryKey: capacityKey(from, to),
      queryFn: ({ signal }) => fetchCapacity(from, to, signal),
      // Keep the previous range on screen while the next one loads, instead
      // of blanking a 500-row grid on every prev/next click.
      placeholderData: keepPreviousData,
    })

  // Per-row saving + error state. Keyed by id so one bad row doesn't poison
  // the rest of the grid.
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set())
  const [rowErrors, setRowErrors] = useState<Record<number, RowError>>({})

  const setWeeklyHoursEverywhere = (id: number, hours: number) =>
    qc.setQueriesData<CapacityData>({ queryKey: capacityPrefix }, (d) =>
      patchWeeklyHours(d ?? null, id, hours) ?? d,
    )

  const saveMutation = useMutation({
    mutationFn: ({ id, next }: SaveVars) => updateWeeklyHours(id, next),

    onMutate: async ({ id, next }) => {
      // Cancel in-flight loads so they can't land with the pre-save value and
      // overwrite the optimistic one. Remember which, so onSettled can reload
      // exactly those and nothing else.
      const interrupted: QueryKey[] = qc
        .getQueryCache()
        .findAll({ queryKey: capacityPrefix, fetchStatus: 'fetching' })
        .map((q) => q.queryKey)
      await qc.cancelQueries({ queryKey: capacityPrefix })

      setWeeklyHoursEverywhere(id, next)
      setRowErrors((e) => {
        const { [id]: _dropped, ...rest } = e
        return rest
      })
      setSavingIds((s) => new Set(s).add(id))

      return { interrupted }
    },

    onError: (err, { id, next, prev }) => {
      setWeeklyHoursEverywhere(id, prev)
      setRowErrors((e) => ({
        ...e,
        [id]: {
          message: err instanceof Error ? err.message : 'save failed',
          attempted: next,
        },
      }))
    },

    onSuccess: (serverPerson, { id }) => {
      // Trust the server's number in case it rounded or clamped.
      setWeeklyHoursEverywhere(id, serverPerson.weekly_hours)
    },

    onSettled: (_data, _err, { id }, ctx) => {
      setSavingIds((s) => {
        const copy = new Set(s)
        copy.delete(id)
        return copy
      })
      for (const queryKey of ctx?.interrupted ?? []) {
        void qc.invalidateQueries({ queryKey, exact: true })
      }
    },
  })

  if (isPending) return <p>Loading…</p>
  if (isError)
    return (
      <p className="error">
        Failed to load: {error instanceof Error ? error.message : 'unknown'}{' '}
        <button type="button" onClick={() => void refetch()}>
          Retry
        </button>
      </p>
    )

  return (
    <>
      <p className="muted status" aria-live="polite">
        {isPlaceholderData ? 'Loading range…' : ' '}
      </p>
      <table className={isPlaceholderData ? 'stale' : undefined}>
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Capacity (hrs/wk)</th>
            {data.weeks.map((w) => (
              <th key={w} scope="col">
                {w}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.people.map((p) => (
            <Row
              key={p.id}
              person={p}
              saving={savingIds.has(p.id)}
              error={rowErrors[p.id]}
              onSave={(next) =>
                saveMutation.mutate({ id: p.id, next, prev: p.weekly_hours })
              }
            />
          ))}
        </tbody>
      </table>
    </>
  )
}

type RowProps = {
  person: Person
  saving: boolean
  error: RowError | undefined
  onSave: (next: number) => void
}

function Row({ person, saving, error, onSave }: RowProps) {
  // Local draft so typing doesn't fire a PATCH per keystroke.
  const [draft, setDraft] = useState(String(person.weekly_hours))
  const lastSentRef = useRef(person.weekly_hours)

  // Keep the draft in sync with the cache. `error` is a dependency too: a fast
  // failure can take the cache 40 → 36 → 40 inside one render batch, so
  // weekly_hours alone never appears to change and the input would keep
  // showing the rejected value.
  useEffect(() => {
    setDraft(String(person.weekly_hours))
    lastSentRef.current = person.weekly_hours
  }, [person.weekly_hours, error])

  const commit = () => {
    const parsed = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > 168) {
      setDraft(String(person.weekly_hours))
      return
    }
    if (parsed === lastSentRef.current) return
    lastSentRef.current = parsed
    onSave(parsed)
  }

  return (
    <>
      <tr>
        <th scope="row">{person.name}</th>
        <td>
          <input
            type="number"
            min={0}
            max={168}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setDraft(String(person.weekly_hours))
            }}
            aria-label={`Weekly hours for ${person.name}`}
            disabled={saving}
          />
          {saving && <span className="muted"> saving…</span>}
        </td>
        {person.allocated.map((hrs, i) => (
          <Cell key={i} allocated={hrs} capacity={person.weekly_hours} />
        ))}
      </tr>
      {error && (
        <tr className="row-error">
          <td colSpan={2 + person.allocated.length}>
            Couldn't save {error.attempted}h: {error.message}{' '}
            <button type="button" onClick={() => onSave(error.attempted)}>
              Retry
            </button>
          </td>
        </tr>
      )}
    </>
  )
}

function Cell({ allocated, capacity }: { allocated: number; capacity: number }) {
  // Capacity of zero is a real case (leave, placeholders). Guard against
  // division by zero and treat any allocation on them as over.
  const ratio =
    capacity > 0 ? allocated / capacity : allocated > 0 ? Infinity : 0
  const tone = ratio >= 1 ? 'over' : ratio >= 0.9 ? 'near' : 'ok'
  const label =
    capacity > 0 ? `${Math.round(ratio * 100)}%` : allocated > 0 ? 'over' : '—'
  return (
    <td
      className={`cell ${tone}`}
      title={`${allocated.toFixed(2)}h / ${capacity}h — ${label}`}
    >
      {allocated === 0 ? '—' : allocated.toFixed(1)}
    </td>
  )
}

// patchWeeklyHours is a pure helper so the test can exercise the cache
// transition without spinning up the component. Keeps the optimistic path
// honest.
export function patchWeeklyHours(
  d: CapacityData | null,
  id: number,
  next: number,
): CapacityData | null {
  if (!d) return d
  return {
    ...d,
    people: d.people.map((p) =>
      p.id === id ? { ...p, weekly_hours: next } : p,
    ),
  }
}
