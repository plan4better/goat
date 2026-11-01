import type { DragEndEvent } from "@dnd-kit/core";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import CloseIcon from "@mui/icons-material/Close";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import {
  Box,
  Button,
  IconButton,
  Stack,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import type { LinksElementSchema, LinksItemSchema } from "@/lib/validations/widget";
import { linksSeparatorTypes } from "@/lib/validations/widget";

import type { SelectorItem } from "@/types/map/common";

import SectionHeader from "@/components/map/panels/common/SectionHeader";
import SectionOptions from "@/components/map/panels/common/SectionOptions";
import SegmentedControl from "@/components/map/panels/common/SegmentedControl";
import Selector from "@/components/map/panels/common/Selector";
import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import LinkPopupEditDialog from "@/components/builder/widgets/elements/LinkPopupEditDialog";
import type { LinkPopupValues } from "@/components/builder/widgets/elements/LinkPopupEditDialog";

interface LinksConfigurationProps {
  config: LinksElementSchema;
  onChange: (config: LinksElementSchema) => void;
}

interface PopupConfigButtonProps {
  link: LinksItemSchema;
  onChange: (values: LinkPopupValues) => void;
}

const PopupConfigButton = ({ link, onChange }: PopupConfigButtonProps) => {
  const { t } = useTranslation("common");
  const [editOpen, setEditOpen] = useState(false);

  return (
    <>
      <Button variant="outlined" onClick={() => setEditOpen(true)}>
        {t("configure_popup", { defaultValue: "Configure popup" })}
      </Button>
      <LinkPopupEditDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSave={onChange}
        contextLabel={link.label}
        initial={{
          popup_content: link.popup_content,
          popup_type: link.popup_type,
          popup_placement: link.popup_placement,
          popup_size: link.popup_size,
        }}
      />
    </>
  );
};

interface SortableLinkItemProps {
  id: string;
  index: number;
  link: LinksItemSchema;
  onLabelChange: (index: number, value: string) => void;
  onUrlChange: (index: number, value: string) => void;
  onLinkTypeChange: (index: number, value: "url" | "popup") => void;
  onPopupChange: (index: number, values: LinkPopupValues) => void;
  onDelete: (index: number) => void;
}

const SortableLinkItem = ({
  id,
  index,
  link,
  onLabelChange,
  onUrlChange,
  onLinkTypeChange,
  onPopupChange,
  onDelete,
}: SortableLinkItemProps) => {
  const theme = useTheme();
  const { t } = useTranslation("common");
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const linkType = (link.link_type as "url" | "popup") ?? "url";

  return (
    <Box
      ref={setNodeRef}
      style={style}
      sx={{
        border: "1px solid",
        borderColor: linkType === "popup" ? "primary.light" : "divider",
        borderRadius: 1,
        p: 1,
        "&:hover": { borderColor: linkType === "popup" ? "primary.main" : theme.palette.action.hover },
      }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Box {...attributes} {...listeners} sx={{ cursor: "grab", display: "flex" }}>
          <DragIndicatorIcon sx={{ fontSize: 14, color: "text.disabled" }} />
        </Box>
        <Typography
          variant="caption"
          fontWeight="bold"
          sx={{
            color: "text.disabled",
            bgcolor: "background.default",
            borderRadius: 0.5,
            px: 0.75,
            py: 0.25,
          }}>
          #{index + 1}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={() => onDelete(index)} sx={{ p: 0.25 }}>
          <CloseIcon sx={{ fontSize: 16, color: "text.disabled", "&:hover": { color: "error.main" } }} />
        </IconButton>
      </Stack>

      <Box sx={{ mb: 1 }}>
        <SegmentedControl
          value={linkType}
          onChange={(value) => onLinkTypeChange(index, value as "url" | "popup")}
          items={[
            { value: "url", label: t("link_url") },
            { value: "popup", label: t("popup") },
          ]}
        />
      </Box>

      <Stack spacing={1}>
        <TextField
          size="small"
          fullWidth
          placeholder={t("link_label")}
          value={link.label}
          onChange={(e) => onLabelChange(index, e.target.value)}
        />
        {linkType === "popup" ? (
          <PopupConfigButton
            link={link}
            onChange={(values) => onPopupChange(index, values)}
          />
        ) : (
          <TextField
            size="small"
            fullWidth
            placeholder="https://..."
            value={link.url ?? ""}
            onChange={(e) => onUrlChange(index, e.target.value)}
          />
        )}
      </Stack>
    </Box>
  );
};

const LinksConfiguration = ({ config, onChange }: LinksConfigurationProps) => {
  const { t } = useTranslation("common");

  const links = config.setup?.links ?? [];
  const options = config.options ?? {};

  const handleSetupChange = useCallback(
    (key: string, value: unknown) => {
      onChange({
        ...config,
        setup: { ...config.setup, [key]: value },
      } as LinksElementSchema);
    },
    [config, onChange]
  );

  const handleOptionChange = useCallback(
    (key: string, value: unknown) => {
      onChange({
        ...config,
        options: { ...config.options, [key]: value },
      } as LinksElementSchema);
    },
    [config, onChange]
  );

  const handleLinkLabelChange = useCallback(
    (index: number, label: string) => {
      const updated = [...links];
      updated[index] = { ...updated[index], label };
      handleSetupChange("links", updated);
    },
    [links, handleSetupChange]
  );

  const handleLinkUrlChange = useCallback(
    (index: number, url: string) => {
      const updated = [...links];
      updated[index] = { ...updated[index], url };
      handleSetupChange("links", updated);
    },
    [links, handleSetupChange]
  );

  const handleLinkTypeChange = useCallback(
    (index: number, link_type: "url" | "popup") => {
      const updated = [...links];
      updated[index] = { ...updated[index], link_type };
      handleSetupChange("links", updated);
    },
    [links, handleSetupChange]
  );

  const handlePopupChange = useCallback(
    (index: number, values: LinkPopupValues) => {
      const updated = [...links];
      updated[index] = { ...updated[index], ...values };
      handleSetupChange("links", updated);
    },
    [links, handleSetupChange]
  );

  const handleDeleteLink = useCallback(
    (index: number) => {
      const updated = links.filter((_, i) => i !== index);
      handleSetupChange("links", updated);
    },
    [links, handleSetupChange]
  );

  const handleAddLink = useCallback(() => {
    handleSetupChange("links", [
      ...links,
      {
        label: "",
        url: "",
        link_type: "url" as const,
        popup_content: "",
        popup_type: "popover" as const,
        popup_placement: "auto" as const,
        popup_size: "md" as const,
      },
    ]);
  }, [links, handleSetupChange]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = links.findIndex((_, i) => `link-${i}` === active.id);
      const newIndex = links.findIndex((_, i) => `link-${i}` === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const updated = [...links];
      const [moved] = updated.splice(oldIndex, 1);
      updated.splice(newIndex, 0, moved);
      handleSetupChange("links", updated);
    },
    [links, handleSetupChange]
  );

  const separatorItems = linksSeparatorTypes.options.map((sep) => ({
    label: t(`separator_${sep}`),
    value: sep,
  }));

  const selectedSeparator = separatorItems.find(
    (item) => item.value === (options.separator ?? "vertical_line")
  );

  return (
    <Stack direction="column" spacing={2} justifyContent="space-between">
      {/* Info Section */}
      <SectionHeader
        active
        alwaysActive
        label={t("info")}
        icon={ICON_NAME.CIRCLEINFO}
        disableAdvanceOptions
      />
      <SectionOptions
        active
        baseOptions={
          <>
            <TextFieldInput
              type="text"
              label={t("title")}
              placeholder={t("add_widget_title")}
              clearable={false}
              value={config.setup?.title || ""}
              onChange={(value: string) => handleSetupChange("title", value)}
            />
            <TextFieldInput
              type="text"
              label={t("description")}
              placeholder={t("add_widget_description")}
              multiline
              clearable={false}
              value={options.description || ""}
              onChange={(value: string) => handleOptionChange("description", value)}
            />
          </>
        }
      />

      {/* Links Section */}
      <SectionHeader
        active
        alwaysActive
        label={t("links")}
        icon={ICON_NAME.LINK}
        disableAdvanceOptions
      />
      <SectionOptions
        active
        baseOptions={
          <Stack spacing={2}>
            <DndContext
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragEnd={handleDragEnd}>
              <SortableContext
                items={links.map((_, i) => `link-${i}`)}
                strategy={verticalListSortingStrategy}>
                <Stack spacing={1}>
                  {links.map((link, index) => (
                    <SortableLinkItem
                      key={`link-${index}`}
                      id={`link-${index}`}
                      index={index}
                      link={link}
                      onLabelChange={handleLinkLabelChange}
                      onUrlChange={handleLinkUrlChange}
                      onLinkTypeChange={handleLinkTypeChange}
                      onPopupChange={handlePopupChange}
                      onDelete={handleDeleteLink}
                    />
                  ))}
                </Stack>
              </SortableContext>
            </DndContext>
            <Button
              variant="text"
              fullWidth
              onClick={handleAddLink}>
              {t("add_link")}
            </Button>
          </Stack>
        }
      />

      {/* Options Section */}
      <SectionHeader
        active
        alwaysActive
        label={t("options")}
        icon={ICON_NAME.SLIDERS}
        disableAdvanceOptions
      />
      <SectionOptions
        active
        baseOptions={
          <Stack spacing={2}>
            <Selector
              selectedItems={selectedSeparator}
              setSelectedItems={(item: SelectorItem) => {
                handleOptionChange("separator", item.value);
              }}
              items={separatorItems}
              label={t("separator")}
            />
            <TextFieldInput
              type="text"
              label={t("secondary_text")}
              placeholder={t("secondary_text_placeholder")}
              clearable={false}
              value={options.secondary_text || ""}
              onChange={(value: string) => handleOptionChange("secondary_text", value)}
            />
          </Stack>
        }
      />
    </Stack>
  );
};

export default LinksConfiguration;
