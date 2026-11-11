import type { Theme } from "@mui/material/styles";

const Button = (theme: Theme) => {
  return {
    // Every button in the app's font. A ButtonBase is a <button>, which the
    // browser gives its own font, and the theme's typography only inherits:
    // without this, bare ButtonBases (tool pills, toggles, role pickers)
    // were drawn in the browser's button font.
    MuiButtonBase: {
      styleOverrides: {
        root: {
          fontFamily: "inherit",
        },
      },
    },
    MuiButton: {
      defaultProps: {
        variant: "contained",
      },
      styleOverrides: {
        root: {
          borderRadius: "50px",
          lineHeight: 1.71,
          letterSpacing: "0.3px",
          textTransform: "none",
          // padding: `${theme.spacing(1.875, 3)}`,
          '&.MuiButton-containedPrimary:not(:disabled)': {
            backgroundColor: theme.palette.primary.main,
            '&:hover': {
              backgroundColor: theme.palette.primary.dark,
            },
          },
        },
        contained: {
          boxShadow: theme.shadows[3],
          padding: `${theme.spacing(1.875, 5.5)}`
        },
        outlined: {
          padding: `${theme.spacing(2)}px ${theme.spacing(4)}px`,
        },
        sizeSmall: {
          padding: `${theme.spacing(1, 2.25)}`,
          "&.MuiButton-contained": {
            padding: `${theme.spacing(1, 3.5)}`,
          },
          "&.MuiButton-outlined": {
            padding: `${theme.spacing(0.75, 3.25)}`,
          },
        },
        sizeLarge: {
          padding: `${theme.spacing(2.125, 5.5)}`,
          "&.MuiButton-contained": {
            padding: `${theme.spacing(2.125, 6.5)}`,
          },
          "&.MuiButton-outlined": {
            padding: `${theme.spacing(1.875, 6.25)}`,
          },
        },
        dialogBoxRectangle: {
          borderRadius: 0,
        }
      },
    },
  };
};

export default Button;
