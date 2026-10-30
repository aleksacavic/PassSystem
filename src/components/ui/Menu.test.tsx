import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Pencil } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { Menu } from './Menu'

const renderMenu = () =>
  render(
    <MemoryRouter>
      <Menu label="More actions" items={[{ label: 'Edit', icon: Pencil, onSelect: () => undefined }]} />
    </MemoryRouter>,
  )

describe('Menu', () => {
  it('closes when the window is resized or rotated (R19-02)', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    fireEvent(window, new Event('resize'))
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('Escape closes it and puts focus back on the ⋯ button', () => {
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'More actions' })
    fireEvent.click(trigger)
    screen.getByRole('button', { name: 'Edit' }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(trigger).toHaveFocus()
  })
})
