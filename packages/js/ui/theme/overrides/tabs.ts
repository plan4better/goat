import type { Theme } from '@mui/material/styles'

const Tabs = (theme: Theme) => {
  return {
    MuiTabs: {
      styleOverrides: {
        vertical: {
          minWidth: 130,
          marginRight: theme.spacing(4),
          borderRight: `1px solid ${theme.palette.divider}`,
          '& .MuiTab-root': {
            minWidth: 130
          }
        }
      }
    },
    MuiTab: {
      styleOverrides: {
        // Labels as written (sentence case), as the buttons' are; MUI draws them in capitals.
        root: {
          textTransform: 'none'
        },
        textColorSecondary: {
          '&.Mui-selected': {
            color: theme.palette.text.secondary
          }
        }
      }
    }
  }
}

export default Tabs
