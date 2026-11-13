import dayjs from "dayjs";
import { v4 } from "uuid";

import { TEMPORAL_VALUE_FORMAT } from "@p4b/ui/components/temporalFormats";

import { type Expression, FilterType } from "@/lib/validations/filter";

export const comparisonAndInclussionOpperators = {
  is: "=",
  is_not: "!=",
  includes: "in",
  excludes: "not",
  is_at_least: ">=",
  is_at_most: "<=",
  is_less_than: "<",
  is_greater_than: ">",
  is_empty_string: "=",
  is_not_empty_string: "!=",
};

function createComparisonCondition(op: string, key: string, value: string | number) {
  return `{"op":"${op}","args":[{"property":"${key}"},${typeof value === "string" ? `"${value}"` : value}]}`;
}

function createNestedCondition(outerOp: string, key: string, value: string, innerOp?: string) {
  return `{"op": "${outerOp}","args": [
      ${innerOp
      ? `{"op":"${innerOp}","args":[{"property":"${key}"},"${value}"]}`
      : `{ "property":"${key}"},
      "${value}"`
    }]}`;
}

export function is(key: string, value: string | number) {
  return createComparisonCondition("=", key, value);
}

// `x <> v` is unknown, not true, where x is empty, so on its own a negation drops the rows without a value. Every
// negation is written with the empty value as an alternative: "is not a" keeps the rows that have no value.
function or_empty(key: string, conditions: string[]) {
  return or_operator([...conditions, is_blank(key)]);
}

export function is_not(key: string, value: string | number) {
  return or_empty(key, [createComparisonCondition("!=", key, value)]);
}

export function includes(key: string, values: (string | number)[]) {
  const args = typeof values === "string" ? [] : values.map((value) => is(key, value));
  return or_operator(args);
}

export function excludes(key: string, values: (string | number)[]) {
  const args =
    typeof values === "string" ? [] : values.map((value) => createComparisonCondition("!=", key, value));
  return or_empty(key, [and_operator(args)]);
}

export function starts_with(key: string, value: string) {
  return createNestedCondition("like", key, `${value}%`);
}

export function ends_with(key: string, value: string) {
  return createNestedCondition("like", key, `%${value}`);
}

export function contains_the_text(key: string, value: string) {
  return createNestedCondition("like", key, `%${value}%`);
}

export function does_not_contains_the_text(key: string, value: string) {
  return or_empty(key, [createNestedCondition("not", key, `%${value}%`, "like")]);
}

export function is_true(key: string) {
  return `{"op":"=","args":[{"property":"${key}"},true]}`;
}

export function is_false(key: string) {
  return `{"op":"=","args":[{"property":"${key}"},false]}`;
}

export function is_blank(key: string) {
  return `{
    "op": "isNull",
    "args": { "property": "${key}" }
  }`;
}

export function is_not_blank(key: string) {
  return `{
    "op": "not",
    "args": [
      {
        "op": "isNull",
        "args": { "property": "${key}" }
      }
    ]
  }`;
}

export function is_empty_string(key: string) {
  return createComparisonCondition("=", key, "");
}

export function is_not_empty_string(key: string) {
  return createComparisonCondition("!=", key, "");
}

export function is_at_least(key: string, value: number) {
  return createComparisonCondition(">=", key, value);
}

export function is_at_most(key: string, value: number) {
  return createComparisonCondition("<=", key, value);
}

export function is_less_than(key: string, value: number) {
  return createComparisonCondition("<", key, value);
}

export function is_greater_than(key: string, value: number) {
  return createComparisonCondition(">", key, value);
}

export function is_between(key: string, value1: number, value2: number) {
  return `{"op":"and","args":[{"op":">=","args":[{"property":"${key}"},${value1}]},{"op":"<=","args":[{"property":"${key}"},${value2}]}]}`;
}

export function s_intersects(geom: string, geomProperty: string = "geom") {
  return `{"op":"s_intersects","args":[{"property":"${geomProperty}"},${geom}]}`;
}

function formatDateLiteral(d: dayjs.Dayjs): string {
  return d.format(TEMPORAL_VALUE_FORMAT);
}

export function toIsoLiteral(value: string): string {
  const d = dayjs(value);
  if (!d.isValid()) return value;
  return formatDateLiteral(d);
}

// "is on" for temporal values means "on that calendar day", not equality on
// the exact second — exact equality would almost never match timestamp data.
export function date_is_on(key: string, value: string) {
  const d = dayjs(value);
  if (!d.isValid()) return is(key, value);
  return date_is_between(
    key,
    formatDateLiteral(d.startOf("day")),
    formatDateLiteral(d.endOf("day"))
  );
}

export function date_is_not_on(key: string, value: string) {
  const d = dayjs(value);
  if (!d.isValid()) return is_not(key, value);
  return date_is_not_between(
    key,
    formatDateLiteral(d.startOf("day")),
    formatDateLiteral(d.endOf("day"))
  );
}

export function date_is_between(key: string, from: string, to: string) {
  return and_operator([
    createComparisonCondition(">=", key, from),
    createComparisonCondition("<=", key, to),
  ]);
}

export function date_is_not_between(key: string, from: string, to: string) {
  return or_empty(key, [
    createComparisonCondition("<", key, from),
    createComparisonCondition(">", key, to),
  ]);
}

export function date_in_the_last(key: string, days: number) {
  const now = dayjs();
  const lower = formatDateLiteral(now.subtract(days, "day"));
  const upper = formatDateLiteral(now);
  return and_operator([
    createComparisonCondition(">=", key, lower),
    createComparisonCondition("<=", key, upper),
  ]);
}

export function date_not_in_the_last(key: string, days: number) {
  const now = dayjs();
  const lower = formatDateLiteral(now.subtract(days, "day"));
  const upper = formatDateLiteral(now);
  return or_empty(key, [
    createComparisonCondition("<", key, lower),
    createComparisonCondition(">", key, upper),
  ]);
}

export function and_operator(args: string[]) {
  return `{"op":"and","args": [${args.map((arg) => `${arg}`)}]}`;
}

export function or_operator(args: string[]) {
  return `{"op":"or","args": [${args.map((arg) => `${arg}`)}]}`;
}


export function createTheCQLBasedOnExpression(
  expressions,
  layerFields: { name: string; type: string; kind?: string }[],
  logicalOperator?: "and" | "or"
) {
  const queries = expressions
    .filter((exp) => exp.expression && exp.attribute)
    .map((expression) => {
      const matchedField = layerFields.find((field) => field.name === expression.attribute);
      const attributeType = matchedField?.type;

      switch (expression.expression) {
        case "is":
          return is(expression.attribute, expression.value);
        case "is_not":
          return is_not(expression.attribute, expression.value);
        case "is_empty_string":
          return is_empty_string(expression.attribute);
        case "is_not_empty_string":
          return is_not_empty_string(expression.attribute);
        case "is_at_least":
          return is_at_least(expression.attribute, expression.value);
        case "is_less_than":
          return is_less_than(expression.attribute, expression.value);
        case "is_greater_than":
          return is_greater_than(expression.attribute, expression.value);
        case "is_at_most":
          return is_at_most(expression.attribute, expression.value);
        case "includes":
          if (attributeType === "string") {
            return includes(expression.attribute, expression.value);
          } else {
            return includes(expression.attribute, expression.value.map(Number));
          }
        case "excludes":
          if (attributeType === "string") {
            return excludes(expression.attribute, expression.value);
          } else {
            return excludes(expression.attribute, expression.value.map(Number));
          }
        case "is_true":
          return is_true(expression.attribute);
        case "is_false":
          return is_false(expression.attribute);
        case "is_blank":
          return is_blank(expression.attribute);
        case "is_not_blank":
          return is_not_blank(expression.attribute);
        case "starts_with":
          return starts_with(expression.attribute, expression.value);
        case "ends_with":
          return ends_with(expression.attribute, expression.value);
        case "contains_the_text":
          return contains_the_text(expression.attribute, expression.value);
        case "does_not_contains_the_text":
          return does_not_contains_the_text(expression.attribute, expression.value);
        case "is_on":
          return date_is_on(expression.attribute, expression.value);
        case "is_not_on":
          return date_is_not_on(expression.attribute, expression.value);
        case "is_before":
          return createComparisonCondition(
            "<",
            expression.attribute,
            toIsoLiteral(expression.value)
          );
        case "is_after":
          return createComparisonCondition(
            ">",
            expression.attribute,
            toIsoLiteral(expression.value)
          );
        case "in_the_last":
          return date_in_the_last(expression.attribute, Number(expression.value));
        case "not_in_the_last":
          return date_not_in_the_last(expression.attribute, Number(expression.value));
        case "is_not_between":
          return date_is_not_between(
            expression.attribute,
            toIsoLiteral(expression.value[0]),
            toIsoLiteral(expression.value[1])
          );
        case "is_between": {
          if (attributeType === "date") {
            return date_is_between(
              expression.attribute,
              toIsoLiteral(expression.value[0]),
              toIsoLiteral(expression.value[1])
            );
          }
          // Numeric bounds arrive as [min, max]; the legacy "35-45" string form
          // is still accepted so older saved filters keep working.
          const [min, max] = Array.isArray(expression.value)
            ? expression.value
            : String(expression.value).split("-");
          return is_between(expression.attribute, Number(min), Number(max));
        }
        case "s_intersects":
          return s_intersects(expression.value, expression.attribute);
      }
    });

  if (logicalOperator === "and") {
    return JSON.parse(and_operator(queries));
  } else {
    return JSON.parse(or_operator(queries));
  }
}

/** A negation without the empty value it is written with (`or_empty`); any other node as it is. Filters saved
 * before negations took the empty value have the bare negation, and read the same. */
function withoutEmptyAlternative(node) {
  if (node.op !== "or" || !Array.isArray(node.args)) return node;
  const rest = node.args.filter((arg) => arg.op !== "isNull");
  if (rest.length === 0 || rest.length === node.args.length) return node;
  return rest.length === 1 ? rest[0] : { ...node, args: rest };
}

function toExpressionObject(expressionsInsideLogicalOperator): Expression[] {
  return expressionsInsideLogicalOperator.map((written) => {
    const expressionToBeProcessed = withoutEmptyAlternative(written);
    const expression: Expression = {
      expression: "",
      attribute: "",
      value: "",
      id: v4(),
      type: FilterType.Logical,
    };

    const value = expressionToBeProcessed.args.length > 0 ? expressionToBeProcessed.args[1] : "";

    if (expressionToBeProcessed.op === "like") {
      switch (true) {
        case value.startsWith("%") && value.endsWith("%"):
          expression.expression = "contains_the_text";
          break;
        case value.endsWith("%"):
          expression.expression = "starts_with";
          break;
        case value.startsWith("%"):
          expression.expression = "ends_with";
          break;
        default:
          expression.expression = "does_not_contains_the_text";
          break;
      }
      expression.attribute = expressionToBeProcessed.args[0].property;
      expression.value = value.replace(/%/g, "");
    } else if (expressionToBeProcessed.op === "isNull") {
      expression.expression = "is_blank";
      expression.attribute = expressionToBeProcessed.args?.property;
    } else if (expressionToBeProcessed.op === "not" && expressionToBeProcessed.args[0].op === "isNull") {
      expression.expression = "is_not_blank";
      expression.attribute = expressionToBeProcessed.args[0].args.property;
    } else if (expressionToBeProcessed.op === "not" && expressionToBeProcessed.args[0].op === "like") {
      const inner = expressionToBeProcessed.args[0];
      expression.expression = "does_not_contains_the_text";
      expression.attribute = inner.args[0].property;
      expression.value = String(inner.args[1]).replace(/%/g, "");
    } else if (expressionToBeProcessed.op === "=" && typeof value === "boolean") {
      expression.expression = value ? "is_true" : "is_false";
      expression.attribute = expressionToBeProcessed.args[0].property;
    } else if (expressionToBeProcessed.op === "=" && value === "") {
      expression.expression = "is_empty_string";
      expression.attribute = expressionToBeProcessed.args[0].property;
    } else if (expressionToBeProcessed.op === "!=" && value === "") {
      expression.expression = "is_not_empty_string";
      expression.attribute = expressionToBeProcessed.args[0].property;
    } else if (["and", "or"].includes(expressionToBeProcessed.op)) {
      // and/or wrap four different expressions. Tell them apart by the operators
      // of their children, not by and/or alone — reading "and" as excludes and
      // "or" as includes mislabels every range as a value list.
      const args = expressionToBeProcessed.args as Array<{ op: string; args: [{ property: string }, unknown] }>;
      const ops = args.map((arg) => arg.op);
      const isAnd = expressionToBeProcessed.op === "and";
      const hasOps = (a: string, b: string) => ops.length === 2 && ops.includes(a) && ops.includes(b);
      const bound = (op: string) => args.find((arg) => arg.op === op)?.args[1];

      if (isAnd && hasOps(">=", "<=")) {
        expression.expression = "is_between";
        expression.value = [bound(">="), bound("<=")] as (string | number)[];
      } else if (!isAnd && hasOps("<", ">")) {
        // "not between from and to" is written as (< from) OR (> to).
        expression.expression = "is_not_between";
        expression.value = [bound("<"), bound(">")] as (string | number)[];
      } else {
        expression.expression = isAnd ? "excludes" : "includes";
        expression.value = args.map((arg) => arg.args[1]) as (string | number)[];
      }
      expression.attribute = args[0].args[0].property;
    } else if (expressionToBeProcessed.op === "s_intersects") {
      expression.expression = "s_intersects";
      expression.attribute = expressionToBeProcessed.args[0].property;
      expression.value = JSON.stringify(expressionToBeProcessed.args[1]);
    } else {
      expression.expression = Object.keys(comparisonAndInclussionOpperators).filter(
        (comp) => comparisonAndInclussionOpperators[comp] === expressionToBeProcessed.op
      )[0];
      expression.attribute = expressionToBeProcessed.args[0].property;
      expression.value = value;
    }

    if (expressionToBeProcessed.op === "s_intersects") {
      expression.type = FilterType.Spatial;
    } else {
      expression.type = FilterType.Logical;
    }

    return expression;
  });
}

export function parseCQLQueryToObject(condition?: { op: string; args: unknown[] }) {
  if (condition && Object.keys(condition).length) {
    let expressions: Expression[] = [];
    const expressionsInsideLogicalOperator = condition.args;
    expressions = toExpressionObject(expressionsInsideLogicalOperator);

    return expressions;
  }

  return [];
}
