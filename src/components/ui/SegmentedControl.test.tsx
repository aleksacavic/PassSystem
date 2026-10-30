import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { SegmentedControl } from './SegmentedControl'

function Harness() {
  const [value, setValue] = useState<'a' | 'b' | 'c'>('a')
  return (
    <SegmentedControl
      label="Filter"
      value={value}
      onChange={setValue}
      options={[
        { value: 'a', label: 'Active' },
        { value: 'b', label: 'Archived' },
        { value: 'c', label: 'All' },
      ]}
    />
  )
}

describe('SegmentedControl', () => {
  it('is one Tab stop and follows radio-group arrow keys', () => {
    render(<Harness />)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1])

    radios[0]!.focus()
    fireEvent.keyDown(radios[0]!, { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'Archived' })).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Archived' }))
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([-1, 0, -1])

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' }) // wraps
    expect(screen.getByRole('radio', { name: 'Active' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' }) // wraps back
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(screen.getByRole('radio', { name: 'Active' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true')
  })

  it('selects on click', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('radio', { name: 'Archived' }))
    expect(screen.getByRole('radio', { name: 'Archived' })).toHaveAttribute('aria-checked', 'true')
  })
})
