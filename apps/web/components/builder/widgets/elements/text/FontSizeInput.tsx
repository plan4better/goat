import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import {
  Divider,
  ListItemText,
  Menu,
  MenuItem,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { useEffect, useState } from "react";

import { formatFontSize, parseFontSize } from "@/lib/constants/typography";

/** Standard typographic point sizes (Word / InDesign / Google Docs) */
const PT_PRESETS = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

/** Common millimetre sizes for print typography */
const MM_PRESETS = [2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25];

interface FontSizeInputProps {
  editor: Editor;
  onOpen?: () => void;
  onClose?: () => void;
  forceClose?: boolean;
}

const FontSizeInput: React.FC<FontSizeInputProps> = ({ editor, onOpen, onClose, forceClose }) => {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const editorState = useEditorState({
    editor,
    selector: ({ editor: e }: { editor: Editor }) => {
      const fontSize = e.getAttributes("textStyle").fontSize as string | undefined;
      return { fontSize: fontSize || null };
    },
  });

  const parsed = parseFontSize(editorState?.fontSize);
  const [unit, setUnit] = useState<string>(parsed.unit);

  // Sync unit when editor selection changes
  useEffect(() => {
    const p = parseFontSize(editorState?.fontSize);
    if (p.unit) setUnit(p.unit);
  }, [editorState?.fontSize]);

  const presets = unit === "mm" ? MM_PRESETS : PT_PRESETS;

  // Close when forceClose becomes true
  useEffect(() => {
    if (forceClose && anchorEl) {
      setAnchorEl(null);
    }
  }, [forceClose, anchorEl]);

  const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    if (anchorEl) {
      setAnchorEl(null);
    } else {
      onOpen?.();
      setAnchorEl(event.currentTarget);
    }
  };

  const handleClose = () => {
    setAnchorEl(null);
    onClose?.();
  };

  const handleSelect = (size: number) => {
    editor.chain().focus().setFontSize(formatFontSize(size, unit)).run();
    handleClose();
  };

  const handleUnitChange = (_: React.MouseEvent<HTMLElement>, newUnit: string | null) => {
    if (newUnit) {
      setUnit(newUnit);
    }
  };

  // Display value: show unit suffix in the button
  const displayValue = `${parsed.size}${parsed.unit}`;

  return (
    <>
      <ToggleButton
        value="fontSize"
        size="small"
        selected={open}
        onClick={handleOpen}
        sx={{ display: "flex", alignItems: "center", minWidth: 44 }}>
        <Typography variant="caption" sx={{ fontWeight: 600, lineHeight: 1, fontSize: "0.8rem" }}>
          {displayValue}
        </Typography>
        <ArrowDropDownIcon fontSize="small" />
      </ToggleButton>

      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        sx={{ zIndex: 1500 }}
        slotProps={{
          paper: {
            onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
            onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
            sx: { maxHeight: 350 },
          },
        }}>
        {/* Unit toggle */}
        <ToggleButtonGroup
          value={unit}
          exclusive
          onChange={handleUnitChange}
          size="small"
          sx={{ mx: 1, mb: 0.5 }}>
          <ToggleButton value="pt">pt</ToggleButton>
          <ToggleButton value="mm">mm</ToggleButton>
        </ToggleButtonGroup>
        <Divider sx={{ my: 0.5 }} />
        {/* Size presets */}
        {presets.map((size) => (
          <MenuItem
            dense
            key={size}
            selected={parsed.size === size && parsed.unit === unit}
            onClick={() => handleSelect(size)}>
            <ListItemText>{size}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
};

export default FontSizeInput;
