import { Box, Typography } from "@mui/material";
import { alpha, styled } from "@mui/material/styles";
import React from "react";

interface Option {
  label: string;
  value: string;
}

interface SlidingToggleProps {
  options: Option[]; // Array of 2-4 options
  activeOption: string; // The currently active option
  onToggle: (selected: string) => void; // Callback for when the toggle changes
}

const SwitchContainer = styled(Box, {
  shouldForwardProp: (prop) => prop !== "optionCount",
})<{ optionCount: number }>(({ theme, optionCount }) => ({
  position: "relative",
  display: "flex",
  width: optionCount === 2 ? "200px" : optionCount === 3 ? "300px" : "400px",
  // Narrower in a narrow header (the assistant dock takes width): the options stay equal and truncate.
  maxWidth: "100%",
  height: "30px",
  backgroundColor: "transparent",
  border: `1px solid ${alpha(theme.palette.primary.main, 0.5)}`,
  borderRadius: "25px",
  overflow: "hidden",
  cursor: "pointer",
}));

const SlidingIndicator = styled(Box, {
  shouldForwardProp: (prop) => prop !== "optionCount",
})<{ optionCount: number }>(({ theme, optionCount }) => ({
  position: "absolute",
  width: `${100 / optionCount}%`,
  height: "100%",
  backgroundColor: theme.palette.primary.main,
  borderRadius: "25px",
  transition: "transform 0.3s ease-in-out",
  zIndex: 1,
}));

const ToggleItem = styled(Box)(({ theme }) => ({
  flex: 1,
  minWidth: 0,
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 2, // Text stays above the sliding indicator
  color: theme.palette.common.white,
}));

const SlidingToggle: React.FC<SlidingToggleProps> = ({ options, activeOption, onToggle }) => {
  const handleSwitchClick = (option: Option) => {
    onToggle(option.value);
  };

  // Calculate the active index
  const activeIndex = options.findIndex((opt) => opt.value === activeOption);
  const translatePercentage = activeIndex * 100;

  return (
    <SwitchContainer optionCount={options.length}>
      {/* Sliding Indicator */}
      <SlidingIndicator
        optionCount={options.length}
        style={{
          transform: `translateX(${translatePercentage}%)`,
        }}
      />
      {/* Render all options dynamically */}
      {options.map((option) => (
        <ToggleItem key={option.value} onClick={() => handleSwitchClick(option)}>
          <Typography
            color={activeOption === option.value ? "inherit" : "primary"}
            variant="body2"
            noWrap
            sx={{ fontWeight: "bold", transition: "color 0.3s ease-in-out" }}>
            {option.label}
          </Typography>
        </ToggleItem>
      ))}
    </SwitchContainer>
  );
};

export default SlidingToggle;
