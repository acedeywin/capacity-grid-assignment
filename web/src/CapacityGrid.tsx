import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

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
// from any future caller.
export const capacityKey = (from: string, to: string) =>
  ['capacity', from, to] as const

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

// CapacityGrid renders one row per person and one column per week, showing
// how allocated each person is and making over-allocation obvious.
//
// Capacity (weekly_hours) is editable from the first data column. Edits are
// optimistic against the TanStack Query cache: we snapshot the current cache,
// patch it immediately, confirm with the server, and roll the snapshot back
// on failure. We deliberately do NOT invalidate the capacity query after a
// successful save — changing weekly_hours moves capacity only, allocation
// comes from assignments and does not move, so the cached allocation stays
// correct. That's the eventual-consistency decision for this surface.
export function CapacityGrid({ from, to }: Props) {
  const qc = useQueryClient()

  const {
    data,
    error,
    isPending,
    isError,
  } = useQuery({
    queryKey: capacityKey(from, to),
    queryFn: ({ signal }) => fetchCapacity(from, to, signal),
  })

  // Per-row saving + error state. Keyed by id so one bad row doesn't poison
  // the rest of the grid.
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set())
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({})

  const saveMutation = useMutation({
    mutationFn: ({ id, next }: { id: number; next: number }) =>
      updateWeeklyHours(id, next),

    onMutate: async ({ id, next }) => {
      // Cancel in-flight refetches so they can't overwrite our optimistic value.
      await qc.cancelQueries({ queryKey: capacityKey(from, to) })

      const previous = qc.getQueryData<CapacityData>(capacityKey(from, to))
      qc.setQueryData<CapacityData>(capacityKey(from, to), (d) =>
        patchWeeklyHours(d ?? null, id, next) ?? d,
      )

      setRowErrors((e) => {
        const { [id]: _dropped, ...rest } = e
        return rest
      })
      setSavingIds((s) => new Set(s).add(id))

      return { previous, id }
    },

    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(capacityKey(from, to), ctx.previous)
      if (ctx?.id != null) {
        setRowErrors((e) => ({
          ...e,
          [ctx.id]: err instanceof Error ? err.message : 'save failed',
        }))
      }
    },

    onSuccess: (serverPerson, { id }) => {
      // Trust the server's number in case it rounded or clamped. Patch cache
      // again rather than invalidating — allocation hasn't moved.
      qc.setQueryData<CapacityData>(capacityKey(from, to), (d) =>
        patchWeeklyHours(d ?? null, id, serverPerson.weekly_hours) ?? d,
      )
    },

    onSettled: (_data, _err, { id }) => {
      setSavingIds((s) => {
        const copy = new Set(s)
        copy.delete(id)
        return copy
      })
    },
  })

  if (isPending) return <p>Loading…</p>
  if (isError)
    return (
      <p className="error">
        Failed to load: {error instanceof Error ? error.message : 'unknown'}
      </p>
    )
  if (!data) return null

  return (
    <table>
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
            onSave={(next) => saveMutation.mutate({ id: p.id, next })}
          />
        ))}
      </tbody>
    </table>
  )
}

type RowProps = {
  person: Person
  saving: boolean
  error: string | undefined
  onSave: (next: number) => void
}

function Row({ person, saving, error, onSave }: RowProps) {
  // Local draft so typing doesn't fire a PATCH per keystroke.
  const [draft, setDraft] = useState(String(person.weekly_hours))
  const lastSentRef = useRef(person.weekly_hours)

  // Keep the draft in sync when the cache updates underneath us (either from
  // the optimistic patch, the server-confirmed value, or a background refetch).
  useEffect(() => {
    setDraft(String(person.weekly_hours))
    lastSentRef.current = person.weekly_hours
  }, [person.weekly_hours])

  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 168) {
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
            Save failed: {error}{' '}
            <button type="button" onClick={() => onSave(Number(draft))}>
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
