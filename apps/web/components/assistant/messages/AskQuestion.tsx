"use client";

import CheckBoxOutlineBlankRounded from "@mui/icons-material/CheckBoxOutlineBlankRounded";
import CheckBoxRounded from "@mui/icons-material/CheckBoxRounded";
import RadioButtonCheckedRounded from "@mui/icons-material/RadioButtonCheckedRounded";
import RadioButtonUncheckedRounded from "@mui/icons-material/RadioButtonUncheckedRounded";
import {
  Box,
  FormControl,
  FormLabel,
  OutlinedInput,
  Stack,
  type Theme,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import { visuallyHidden } from "@mui/utils";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { type Choice, chooseOption, chooseOther, displayOrder, typeOther } from "@/lib/assistant/ask";
import { plain } from "@/lib/assistant/chips";
import type { AskQuestion } from "@/lib/assistant/types";

import { accentSoft, accentText, focusRing, mutedText } from "@/components/assistant/styles";

/**
 * One question of an ask card (contract "The ask card"), shared by the panel
 * that asks it at the dock's foot and the transcript that shows it. Each
 * choice is a whole row: its native radio or checkbox is out of sight but
 * keeps the role, the name and the keyboard, and the row shows the pick.
 */

/** A row's text lines are 20px high: the number, the title and the mark at its right line up. */
const LINE = "20px";
/** The room of an option's number, and the gap between the parts of a row. */
const NUMBER_WIDTH = 8;
const GAP = 10;

/** The question's header as a chip. */
export const askChipSx = (theme: Theme) => ({
  display: "inline-block",
  px: "8px",
  borderRadius: "999px",
  fontSize: 11,
  fontWeight: 700,
  lineHeight: 1.6,
  bgcolor: accentSoft(theme),
  color: accentText(theme),
});

/** The frame of a row: its border and tint show the pick, its outline the keyboard focus of its input. */
/**
 * The frame of a row: its border and tint show the pick. An input in it with
 * the keyboard focus (its hidden radio or checkbox, the own answer's field)
 * rings it, as the browser decides it on every focus.
 */
const frameSx = (theme: Theme, { picked, disabled }: { picked: boolean; disabled: boolean }) => ({
  position: "relative",
  border: 1,
  borderColor: picked ? alpha(theme.palette.primary.main, 0.6) : theme.palette.divider,
  borderRadius: "10px",
  bgcolor: picked ? accentSoft(theme) : theme.palette.background.paper,
  transition: theme.transitions.create(["background-color", "border-color"], { duration: 120 }),
  "&:has(input:focus-visible)": { outline: `2px solid ${accentText(theme)}`, outlineOffset: "2px" },
  ...(!disabled && !picked && { "&:hover": { bgcolor: theme.palette.action.hover } }),
});

/**
 * The row's label. A row that does not ask (the transcript) is muted, so it
 * does not read as clickable; above a "more" toggle its bottom padding gives way.
 */
const rowSx = (
  clickable: boolean,
  { muted = false, tight = false }: { muted?: boolean; tight?: boolean } = {}
) => ({
  display: "flex",
  alignItems: "flex-start",
  gap: `${GAP}px`,
  px: "12px",
  pt: "8px",
  pb: tight ? "2px" : "8px",
  cursor: clickable ? "pointer" : "default",
  ...(muted && { opacity: 0.6 }),
});

const titleSx = {
  flex: "1 1 auto",
  minWidth: 0,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: LINE,
  color: "text.primary",
  overflowWrap: "anywhere",
} as const;

/** The pick at the right of a row: a dot for a single choice, a check for a multiple one. */
function Mark({ multi, picked }: { multi: boolean; picked: boolean }) {
  const theme = useTheme();
  const Icon = multi
    ? picked
      ? CheckBoxRounded
      : CheckBoxOutlineBlankRounded
    : picked
      ? RadioButtonCheckedRounded
      : RadioButtonUncheckedRounded;
  return (
    <Icon
      aria-hidden
      sx={{
        flexShrink: 0,
        fontSize: 20,
        color: picked ? theme.palette.primary.main : alpha(theme.palette.text.primary, 0.38),
      }}
    />
  );
}

/**
 * An option's description, cut to two lines: `cut` when the browser measures
 * more text than shows (scroll height above the shown height), `open` once
 * "more" showed all of it.
 */
function useClamp(text: string | undefined) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, text]);
  return { ref, cut, open, setOpen };
}

/**
 * One choice as a whole row: number, title (with its badge) and description,
 * and the mark of the pick at its right. The label is the whole row, so a
 * click anywhere on it picks; `children` (the own answer's field) sit in the
 * frame below it.
 */
function ChoiceRow({
  multi,
  name,
  picked,
  disabled,
  onPick,
  onClick,
  number,
  labelId,
  title,
  description,
  keyShortcut,
  children,
}: {
  multi: boolean;
  name: string;
  picked: boolean;
  disabled: boolean;
  onPick: (checked: boolean) => void;
  onClick?: () => void;
  /** The key that picks the row; null keeps its room (the own answer's row), undefined shows none. */
  number?: number | null;
  labelId: string;
  /** The title line: the title, then a badge that sits at its right end. */
  title: ReactNode;
  description?: { id: string; text: string };
  keyShortcut?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const clamp = useClamp(description?.text);
  /** "more" or "less": only for a description cut to its two lines. */
  const toggle = !!description && (clamp.cut || clamp.open);
  return (
    <Box sx={frameSx(theme, { picked, disabled })}>
      <Box component="label" sx={rowSx(!disabled, { muted: disabled, tight: toggle })}>
        <input
          type={multi ? "checkbox" : "radio"}
          name={multi ? undefined : name}
          checked={picked}
          disabled={disabled}
          onChange={(event) => onPick(event.target.checked)}
          onClick={onClick}
          aria-labelledby={labelId}
          aria-describedby={description?.id}
          aria-keyshortcuts={keyShortcut}
          style={visuallyHidden}
        />
        {number !== undefined && (
          <Box
            component="span"
            aria-hidden
            sx={{
              flexShrink: 0,
              width: `${NUMBER_WIDTH}px`,
              fontSize: 11,
              fontWeight: 700,
              lineHeight: LINE,
              color: mutedText(theme),
              fontVariantNumeric: "tabular-nums",
            }}>
            {number}
          </Box>
        )}
        <Box component="span" sx={{ flex: 1, minWidth: 0 }}>
          {/* The title takes the line; a badge that does not fit beside it wraps below, at the right. */}
          <Box
            component="span"
            id={labelId}
            sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: "8px", rowGap: "2px" }}>
            {title}
          </Box>
          {description && (
            <Typography
              ref={clamp.ref}
              component="span"
              id={description.id}
              sx={{
                display: clamp.open ? "block" : "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: clamp.open ? "unset" : 2,
                overflow: "hidden",
                mt: "2px",
                fontSize: 12,
                lineHeight: 1.45,
                color: mutedText,
                overflowWrap: "anywhere",
              }}>
              {description.text}
            </Typography>
          )}
        </Box>
        <Mark multi={multi} picked={picked} />
      </Box>
      {/* Below the label, under the description's start: a label holds one control. */}
      {toggle && (
        <Box
          component="button"
          type="button"
          aria-expanded={clamp.open}
          aria-controls={description.id}
          onClick={() => clamp.setOpen(!clamp.open)}
          sx={{
            display: "block",
            ml: `${12 + (number !== undefined ? NUMBER_WIDTH + GAP : 0)}px`,
            mb: "8px",
            p: 0,
            border: 0,
            bgcolor: "transparent",
            cursor: "pointer",
            font: "inherit",
            fontSize: 12,
            fontWeight: 700,
            lineHeight: 1.45,
            color: accentText(theme),
            borderRadius: "4px",
            ...focusRing(theme),
          }}>
          {t(clamp.open ? "assistant_ask_less" : "assistant_ask_more")}
        </Box>
      )}
      {children}
    </Box>
  );
}

/** "Recommended", at the right end of an option's title line. */
function RecommendedBadge() {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Typography
      component="span"
      sx={{
        ml: "auto",
        flexShrink: 0,
        px: "6px",
        borderRadius: "999px",
        border: 1,
        borderColor: alpha(theme.palette.primary.main, 0.5),
        fontSize: 10.5,
        fontWeight: 700,
        lineHeight: 1.6,
        color: accentText(theme),
      }}>
      {t("assistant_ask_recommended")}
    </Typography>
  );
}

/** The chip and the question: the legend that names the question's fieldset. Without `header`, only the question. */
function QuestionLegend({ question, header = true }: { question: AskQuestion; header?: boolean }) {
  const theme = useTheme();
  return (
    <>
      {header && (
        <>
          <Box component="span" sx={askChipSx(theme)}>
            {question.header}
          </Box>{" "}
        </>
      )}
      <Typography
        component="span"
        sx={{
          display: "block",
          mt: header ? "6px" : 0,
          fontSize: 13.5,
          fontWeight: 700,
          lineHeight: 1.45,
          color: "text.primary",
          overflowWrap: "anywhere",
        }}>
        {question.question}
      </Typography>
    </>
  );
}

export function QuestionField({
  question,
  choice,
  onChange,
  onOptionClick,
  shortcuts = false,
  header = true,
  disabled,
  name,
}: {
  question: AskQuestion;
  choice: Choice;
  onChange: (next: Choice) => void;
  /** A single choice option was clicked (by pointer or keyboard), picked already or not. */
  onOptionClick?: (index: number) => void;
  /** Each option is picked with the number of its place (1 to 4): shown, and announced with `aria-keyshortcuts`. */
  shortcuts?: boolean;
  /** The header chip above the question; left out where a tab shows the header already. */
  header?: boolean;
  disabled: boolean;
  /** Unique per question: the radio group's name and the base of its ids. */
  name: string;
}) {
  const { t } = useTranslation("common");
  const multi = question.multi_select;
  const legendId = `${name}-legend`;
  const order = displayOrder(question);
  /** The arrow keys move through the radios: a row they reach is browsed to, its field does not take the focus. */
  const browsing = useRef(false);
  /** The own answer's row was picked by a click (pointer, Space): its field takes the focus once it opens. */
  const focusOwn = useRef(false);
  const ownField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOwn.current && choice.other) ownField.current?.focus();
    focusOwn.current = false;
  }, [choice.other]);

  const options = order.map((index, place) => {
    const option = question.options[index];
    const picked = choice.options.includes(index);
    return (
      <ChoiceRow
        key={index}
        multi={multi}
        name={name}
        picked={picked}
        disabled={disabled}
        onPick={(checked) => onChange(chooseOption(choice, index, multi, checked))}
        onClick={!multi && onOptionClick ? () => onOptionClick(index) : undefined}
        number={shortcuts ? place + 1 : undefined}
        keyShortcut={shortcuts ? String(place + 1) : undefined}
        labelId={`${name}-l${index}`}
        title={
          <>
            <Typography component="span" sx={titleSx}>
              {option.label}
            </Typography>
            {/* The space keeps "Recommended" a word of its own in the option's accessible name. */}
            {option.recommended && " "}
            {option.recommended && <RecommendedBadge />}
          </>
        }
        description={option.description ? { id: `${name}-d${index}`, text: option.description } : undefined}
      />
    );
  });
  // The own answer is a choice of its own; its field opens once the row is picked, and closes
  // when another option takes its place (the text stays in the choice for a second pick).
  // Without text it is not part of the answer, which the hint under the field says.
  const ownOpen = !disabled && choice.other;
  const ownEmpty = ownOpen && !choice.text.trim();
  const ownHintId = `${name}-other-hint`;
  const fieldStart = 12 + (shortcuts ? NUMBER_WIDTH + GAP : 0);
  const own = (
    <ChoiceRow
      multi={multi}
      name={name}
      picked={choice.other}
      disabled={disabled}
      onPick={(checked) => onChange(chooseOther(choice, multi, checked))}
      onClick={() => {
        if (!browsing.current) focusOwn.current = true;
      }}
      number={shortcuts ? null : undefined}
      labelId={`${name}-own`}
      title={
        <Typography component="span" sx={titleSx}>
          {t("assistant_ask_own_answer")}
        </Typography>
      }>
      {ownOpen && (
        <Box sx={{ pl: `${fieldStart}px`, pr: "12px", pb: "10px" }}>
          <OutlinedInput
            size="small"
            fullWidth
            inputRef={ownField as Ref<HTMLInputElement>}
            value={choice.text}
            onChange={(event) => onChange(typeOther(choice, multi, event.target.value))}
            placeholder={t("assistant_ask_other_placeholder")}
            inputProps={{
              "aria-label": t("assistant_ask_other_label", plain({ header: question.header })),
              "aria-describedby": ownEmpty ? ownHintId : undefined,
              maxLength: 300,
              style: { padding: "8px 12px" },
            }}
            sx={{ fontSize: "0.875rem", bgcolor: "background.paper" }}
          />
          {ownEmpty && (
            <Typography id={ownHintId} sx={{ mt: "4px", fontSize: 12, lineHeight: 1.45, color: mutedText }}>
              {t("assistant_ask_other_empty")}
            </Typography>
          )}
        </Box>
      )}
    </ChoiceRow>
  );
  const rows = (
    <>
      {options}
      {own}
    </>
  );
  return (
    <FormControl
      component="fieldset"
      disabled={disabled}
      onKeyDown={(event: KeyboardEvent) => {
        browsing.current = event.key.startsWith("Arrow");
      }}
      onKeyUp={() => {
        browsing.current = false;
      }}
      sx={{ m: 0, p: 0, border: 0, minWidth: 0 }}>
      <FormLabel
        component="legend"
        id={legendId}
        sx={{
          p: 0,
          mb: "8px",
          color: "text.primary",
          "&.Mui-focused, &.Mui-disabled": { color: "text.primary" },
        }}>
        <QuestionLegend question={question} header={header} />
      </FormLabel>
      {multi ? (
        <Stack gap="6px">{rows}</Stack>
      ) : (
        <Stack gap="6px" role="radiogroup" aria-labelledby={legendId}>
          {rows}
        </Stack>
      )}
    </FormControl>
  );
}

/** A picked choice of an answered card: a row as the panel showed it, without an input. */
function PickedRow({ multi, text }: { multi: boolean; text: string }) {
  const theme = useTheme();
  return (
    <Box sx={frameSx(theme, { picked: true, disabled: true })}>
      <Box sx={rowSx(false)}>
        <Typography component="span" sx={titleSx}>
          {text}
        </Typography>
        <Mark multi={multi} picked />
      </Box>
    </Box>
  );
}

/** A question of a card a typed reply passed over: what it offered, muted, with nothing to pick. */
export function PassedQuestion({ question }: { question: AskQuestion }) {
  return (
    <Stack gap="6px">
      <Box>
        <QuestionLegend question={question} />
      </Box>
      <Typography sx={{ fontSize: 13, lineHeight: 1.45, color: mutedText, overflowWrap: "anywhere" }}>
        {displayOrder(question)
          .map((index) => question.options[index].label)
          .join(" · ")}
      </Typography>
    </Stack>
  );
}

/** A question with what its answer picked: a row per label and for the free text, or "No answer". */
export function AnsweredQuestion({ question, parts }: { question: AskQuestion; parts: string[] }) {
  const { t } = useTranslation("common");
  return (
    <Stack gap="6px">
      <Box>
        <QuestionLegend question={question} />
      </Box>
      {parts.length ? (
        parts.map((part, index) => <PickedRow key={index} multi={question.multi_select} text={part} />)
      ) : (
        <Typography sx={{ fontSize: 13, lineHeight: 1.45, color: mutedText }}>
          {t("assistant_ask_no_answer")}
        </Typography>
      )}
    </Stack>
  );
}
