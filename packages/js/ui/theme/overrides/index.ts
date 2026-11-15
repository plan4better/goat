import type { Theme } from "@mui/material/styles";

import MuiAvatar from "./avatar";
import Button from "./button";
import Card from "./card";
import Chip from "./chip";
import Tooltip from "./tooltip";
import MuiTabs from "./tabs";
import MuiInput from "./input";
import MuiPaper from "./paper";
import MuiAlerts from "./alerts";
import MuiDialog from "./dialog";
import MuiSelect from "./select";
import MuiDivider from "./divider";
import MuiSnackbar from "./snackbar";
import MuiSwitches from "./switches";
import MuiTypography from "./typography";
import MuiDateTimePicker from "./dateTimePicker";
import MuiAppBar from "./appbar";
import Menu from "./menu";
import Link from "./link";
import CssBaseline from "./cssbaseline";
const Overrides = (theme: Theme) => {
  return {
    ...MuiAvatar(theme),
    ...Button(theme),
    ...Card(theme),
    ...Chip(theme),
    ...Tooltip(),
    ...MuiTabs(theme),
    ...MuiInput(theme),
    ...MuiPaper(),
    ...MuiAlerts(theme),
    ...MuiDialog(theme),
    ...MuiSelect(),
    ...MuiDivider(theme),
    ...MuiSnackbar(theme),
    ...MuiSwitches(theme),
    ...MuiTypography(theme),
    ...MuiDateTimePicker(theme),
    ...MuiAppBar(theme),
    ...Menu(theme),
    ...Link(),
    ...CssBaseline(theme),
  };
};

export default Overrides;
