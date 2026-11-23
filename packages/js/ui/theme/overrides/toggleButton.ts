import { alpha } from '@mui/material/styles'
import type { Theme } from '@mui/material/styles'

// A group of toggle buttons is a switch between options: a soft track with the selected option as a chip on it. Only
// buttons in a group are styled, through the group's own slots; a toggle button on its own (a toolbar button) keeps
// the default look.
const ToggleButton = (theme: Theme) => {
  const light = theme.palette.mode === 'light'
  const ink = theme.palette.text.primary

  return {
    MuiToggleButtonGroup: {
      styleOverrides: {
        root: {
          gap: 2,
          padding: 2,
          borderRadius: 8,
          backgroundColor: alpha(ink, 0.07)
        },
        // Over the full width the options share the room evenly, whatever their words' length.
        fullWidth: {
          '& .MuiToggleButtonGroup-grouped': {
            flex: 1,
            paddingLeft: 8,
            paddingRight: 8
          }
        },
        // The default joins the buttons into one outlined bar: each one gets its border, margin and corners back.
        grouped: {
          margin: 0,
          border: 0,
          borderTopLeftRadius: 6,
          borderTopRightRadius: 6,
          borderBottomRightRadius: 6,
          borderBottomLeftRadius: 6,
          minWidth: 0,
          padding: '4px 12px',
          fontSize: 13,
          fontWeight: 600,
          lineHeight: '20px',
          textTransform: 'none' as const,
          color: theme.palette.text.secondary,
          transition: theme.transitions.create(['background-color', 'color', 'box-shadow'], {
            duration: theme.transitions.duration.shortest
          }),
          '&:hover': {
            color: ink,
            backgroundColor: 'transparent'
          },
          '&.Mui-selected, &.Mui-selected:hover': {
            color: ink,
            backgroundColor: light ? theme.palette.common.white : alpha(ink, 0.17),
            boxShadow: light ? '0 1px 2px rgba(58, 53, 65, 0.22)' : '0 1px 2px rgba(10, 12, 20, 0.35)'
          },
          '&.Mui-disabled': {
            border: 0,
            color: theme.palette.text.disabled
          },
          '&.Mui-focusVisible': {
            boxShadow: `0 0 0 2px ${alpha(ink, 0.45)}`
          }
        }
      }
    }
  }
}

export default ToggleButton
