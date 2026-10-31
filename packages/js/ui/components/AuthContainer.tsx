import { Card, CardContent, Stack, Typography, useTheme } from "@mui/material";
export default function AuthContainer({
  headerTitle,
  headerAlert,
  body,
  footer,
  otherFooterActions,
}: {
  headerTitle: React.ReactNode;
  headerAlert?: React.ReactNode;
  body: React.ReactNode;
  footer?: React.ReactNode;
  otherFooterActions?: React.ReactNode;
}) {
  const theme = useTheme();

  return (
    <Card
      sx={{
        // 490 wide, but never wider than a phone: a fixed width stuck out on both sides.
        width: "100%",
        maxWidth: 490,
        height: "fit-content",
        marginBottom: theme.spacing(4),
      }}
    >
      <CardContent>
        <Stack
          spacing={theme.spacing(4)}
          sx={{
            mb: theme.spacing(4),
            textAlign: "center",
          }}
        >
          {/* Styled as a title but not a heading: callers render their own
              heading inside, and a heading may not contain another. */}
          <Typography
            variant="h5"
            component="div"
            sx={{
              pb: theme.spacing(4),
            }}
          >
            {headerTitle}
          </Typography>
          {/* Alert message*/}
          {headerAlert}
        </Stack>
        {/* Main Body*/}
        {body}
        {/* For links displayed under main body (e.g New User ? Create Accounts) */}
        {footer}
      </CardContent>
      {otherFooterActions && (
        <Stack
          justifyContent="flex-end"
          direction="row"
          spacing={theme.spacing(2)}
          sx={{
            pb: theme.spacing(2),
            px: theme.spacing(4),
          }}
        >
          {/* For other actions such as language selection, theme etc. */}
          {otherFooterActions}
        </Stack>
      )}
    </Card>
  );
}
