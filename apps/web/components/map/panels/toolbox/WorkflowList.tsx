import WorkflowIcon from "@mui/icons-material/AccountTree";
import {
  Box,
  CircularProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemSecondaryAction,
  ListItemText,
  Typography,
} from "@mui/material";
import { useParams } from "next/navigation";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useWorkflows } from "@/lib/api/workflows";

interface WorkflowListProps {
  onSelectWorkflow: (workflowId: string) => void;
}

export default function WorkflowList({ onSelectWorkflow }: WorkflowListProps) {
  const { t } = useTranslation("common");
  const { projectId } = useParams();

  const { workflows, isLoading } = useWorkflows(projectId as string);

  if (isLoading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!workflows || workflows.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {t("no_workflows_available")}
        </Typography>
      </Box>
    );
  }

  return (
    <List dense sx={{ pt: 0 }}>
      {workflows.map((workflow) => (
        <ListItemButton key={workflow.id} onClick={() => onSelectWorkflow(workflow.id)}>
          <ListItemIcon sx={{ minWidth: 32 }}>
            <WorkflowIcon sx={{ fontSize: 18, color: "text.secondary" }} />
          </ListItemIcon>
          <ListItemText
            primary={workflow.name}
            secondary={workflow.description}
            secondaryTypographyProps={{
              variant: "caption",
              // Two lines at most, cut at a word; a blank line in the text stays a space.
              sx: {
                opacity: 0.7,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              },
            }}
          />
          <ListItemSecondaryAction>
            <Icon iconName={ICON_NAME.CHEVRON_RIGHT} sx={{ fontSize: "12px" }} />
          </ListItemSecondaryAction>
        </ListItemButton>
      ))}
    </List>
  );
}
