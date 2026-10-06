import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom/vitest'
import {
  CapacityGrid,
  capacityKey,
  patchWeeklyHours,
  type CapacityData,
} from './CapacityGrid'

const sample: CapacityData = {
  weeks: ['2026-01-05', '2026-01-12'],
  people: [
    { id: 1, name: 'Ana Ferreira', weekly_hours: 40, allocated: [20, 60] },
    { id: 2, name: 'Bo Lindqvist', weekly_hours: 40, allocated: [10, 10] },
  ],
}

function renderWithClient(ui: React.ReactElement) {
  // Fresh client per test so cache doesn't bleed. Disable retries so a mocked
  // error doesn't quietly re-fire.
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
  return client
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

// Route by URL so concurrent requests can't consume each other's responses.
// `patch` returns a promise per person so a test can resolve them in any order.
function mockApi(patch: (id: number, hours: number) => Promise<Response>) {
  const impl = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith('/api/capacity')) return Promise.resolve(json(sample))
    const id = Number(url.split('/').pop())
    const { weekly_hours } = JSON.parse(String(init?.body))
    return patch(id, weekly_hours)
  })
  vi.stubGlobal('fetch', impl)
  return impl
}

const hoursInput = (name: string) =>
  screen.getByLabelText(`Weekly hours for ${name}`) as HTMLInputElement

function edit(name: string, value: string) {
  const input = hoursInput(name)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('patchWeeklyHours', () => {
  it('replaces only the targeted person', () => {
    const out = patchWeeklyHours(sample, 1, 36)!
    expect(out.people[0].weekly_hours).toBe(36)
    expect(out.people[1].weekly_hours).toBe(40)
  })

  it('does not mutate the input', () => {
    patchWeeklyHours(sample, 1, 99)
    expect(sample.people[0].weekly_hours).toBe(40)
  })
})

describe('CapacityGrid save flow', () => {
  afterEach(() => {
    // Vitest globals are off, so RTL's auto-cleanup isn't registered.
    cleanup()
    vi.unstubAllGlobals()
  })

  it('reverts and shows an inline error when PATCH fails', async () => {
    mockApi(() =>
      Promise.resolve(
        new Response('weekly_hours must be between 0 and 168', { status: 400 }),
      ),
    )
    renderWithClient(<CapacityGrid from="2026-01-05" to="2026-01-18" />)
    await screen.findByLabelText('Weekly hours for Ana Ferreira')
    expect(hoursInput('Ana Ferreira').value).toBe('40')

    edit('Ana Ferreira', '36')

    await screen.findByText(/Couldn't save 36h/i)
    // Fast failure: the cache goes 40 → 36 → 40 in one batch. The input must
    // still come back to the saved value.
    await waitFor(() => expect(hoursInput('Ana Ferreira').value).toBe('40'))
  })

  it('Retry resends the value that failed, not the reverted one', async () => {
    const sent: number[] = []
    let fail = true
    mockApi((id, hours) => {
      sent.push(hours)
      if (fail) return Promise.resolve(new Response('db down', { status: 500 }))
      return Promise.resolve(json({ id, name: 'Ana Ferreira', weekly_hours: hours }))
    })
    renderWithClient(<CapacityGrid from="2026-01-05" to="2026-01-18" />)
    await screen.findByLabelText('Weekly hours for Ana Ferreira')

    edit('Ana Ferreira', '36')
    await screen.findByText(/Couldn't save 36h/i)

    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(hoursInput('Ana Ferreira').value).toBe('36'))
    expect(sent).toEqual([36, 36])
    expect(screen.queryByText(/Couldn't save/i)).not.toBeInTheDocument()
  })

  it("a failed save on one row does not undo another row's successful save", async () => {
    const ana = deferred<Response>()
    const bo = deferred<Response>()
    mockApi((id) => (id === 1 ? ana.promise : bo.promise))
    renderWithClient(<CapacityGrid from="2026-01-05" to="2026-01-18" />)
    await screen.findByLabelText('Weekly hours for Ana Ferreira')

    edit('Ana Ferreira', '36')
    edit('Bo Lindqvist', '30')

    bo.resolve(json({ id: 2, name: 'Bo Lindqvist', weekly_hours: 30 }))
    await waitFor(() => expect(hoursInput('Bo Lindqvist')).not.toBeDisabled())

    ana.resolve(new Response('nope', { status: 500 }))
    await screen.findByText(/Couldn't save 36h/i)

    expect(hoursInput('Ana Ferreira').value).toBe('40')
    expect(hoursInput('Bo Lindqvist').value).toBe('30')
  })

  it('patches weekly_hours in other cached ranges, not just the visible one', async () => {
    mockApi((id, hours) =>
      Promise.resolve(json({ id, name: 'Ana Ferreira', weekly_hours: hours })),
    )
    const client = renderWithClient(
      <CapacityGrid from="2026-01-05" to="2026-01-18" />,
    )
    // A range the manager visited earlier and could navigate back to.
    const otherKey = capacityKey('2025-12-29', '2026-01-11')
    client.setQueryData(otherKey, sample)
    await screen.findByLabelText('Weekly hours for Ana Ferreira')

    edit('Ana Ferreira', '36')

    await waitFor(() =>
      expect(
        client.getQueryData<CapacityData>(otherKey)!.people[0].weekly_hours,
      ).toBe(36),
    )
  })
})
