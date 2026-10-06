import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom/vitest'
import {
  CapacityGrid,
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
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
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

describe('CapacityGrid optimistic save and revert', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockFetchSequence(responses: Response[]) {
    const impl = vi.fn()
    for (const r of responses) impl.mockReturnValueOnce(Promise.resolve(r))
    vi.stubGlobal('fetch', impl)
    return impl
  }

  it('reverts and shows an inline error when PATCH fails', async () => {
    mockFetchSequence([
      new Response(JSON.stringify(sample), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response('weekly_hours must be between 0 and 168', { status: 400 }),
    ])

    renderWithClient(<CapacityGrid from="2026-01-05" to="2026-01-18" />)

    const input = (await screen.findByLabelText(
      'Weekly hours for Ana Ferreira',
    )) as HTMLInputElement
    expect(input.value).toBe('40')

    fireEvent.change(input, { target: { value: '36' } })
    fireEvent.blur(input)

    // Error row appears, and the value reverts to the server-trusted 40.
    await waitFor(() => {
      expect(screen.getByText(/Save failed/i)).toBeInTheDocument()
    })
    await waitFor(() => {
      const after = screen.getByLabelText(
        'Weekly hours for Ana Ferreira',
      ) as HTMLInputElement
      expect(after.value).toBe('40')
    })
  })
})
