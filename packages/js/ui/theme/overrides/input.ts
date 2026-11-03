// ** MUI Imports
import type { Theme } from '@mui/material/styles'
import { alpha } from '@mui/material/styles'

const input = (theme: Theme) => {
  return {
    // Small inputs are the panels', forms' and dialogs' size and read in body2, like the
    // selects and lists beside them; InputBase would otherwise use body1. Medium inputs
    // (a page's large search) keep body1.
    MuiInputBase: {
      styleOverrides: {
        sizeSmall: {
          fontSize: theme.typography.body2.fontSize
        }
      }
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          color: theme.palette.text.secondary
        }
      }
    },
    MuiInput: {
      styleOverrides: {
        root: {
          '&:before': {
            borderBottom: `1px solid ${alpha(theme.palette.customColors.main, 0.22)}`
          },
          '&:hover:not(.Mui-disabled):before': {
            borderBottom: `1px solid ${alpha(theme.palette.customColors.main, 0.32)}`
          },
          '&.Mui-disabled:before': {
            borderBottom: `1px solid ${theme.palette.text.disabled}`
          }
        }
      }
    },
    MuiFilledInput: {
      styleOverrides: {
        root: {
          backgroundColor: alpha(theme.palette.customColors.main, 0.04),
          '&:hover:not(.Mui-disabled)': {
            backgroundColor: alpha(theme.palette.customColors.main, 0.08)
          },
          '&:before': {
            borderBottom: `1px solid ${alpha(theme.palette.customColors.main, 0.22)}`
          },
          '&:hover:not(.Mui-disabled):before': {
            borderBottom: `1px solid ${alpha(theme.palette.customColors.main, 0.32)}`
          }
        }
      }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          '&:hover:not(.Mui-focused) .MuiOutlinedInput-notchedOutline': {
            borderColor: alpha(theme.palette.customColors.main, 0.32)
          },
          '&:hover.Mui-error .MuiOutlinedInput-notchedOutline': {
            borderColor: theme.palette.error.main
          },
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: alpha(theme.palette.customColors.main, 0.22)
          },
          '&.Mui-disabled .MuiOutlinedInput-notchedOutline': {
            borderColor: theme.palette.text.disabled
          }
        }
      }
    }
  }
}

export default input
