import { dir } from "i18next";
import type { Metadata } from "next";
import { Mulish } from "next/font/google";
import { cookies } from "next/headers";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import "react-toastify/dist/ReactToastify.css";
import "@p4b/ui/assets/fonts/index.css";

import { fallbackLng } from "@/i18n/settings";

import { LANGUAGE_COOKIE_NAME } from "@/lib/constants";
import { getLocalizedMetadata } from "@/lib/metadata";
import AuthProvider from "@/lib/providers/AuthProvider";
import { I18nProvider } from "@/lib/providers/I18nProvider";
// Providers and UI
import StoreProvider from "@/lib/providers/StoreProvider";
import ToastProvider from "@/lib/providers/ToastProvider";
import { getUserPreferencesForLayout } from "@/lib/server/getUserPreferences";

import ThemeRegistry from "@/components/@mui/ThemeRegistry";
import AssistantRoot from "@/components/assistant/AssistantRoot";

import "@/styles/globals.css";

// --- Metadata ---
export async function generateMetadata(): Promise<Metadata> {
  const cookieStore = await cookies();
  const lng = cookieStore.get(LANGUAGE_COOKIE_NAME)?.value ?? fallbackLng;
  return getLocalizedMetadata(lng);
}

const mulish = Mulish({
  subsets: ["latin"],
});

export const dynamic = "force-dynamic";

// --- Layout ---
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { lang, theme } = await getUserPreferencesForLayout();
  return (
    <html lang={lang} dir={dir(lang)}>
      <body className={mulish.className}>
        <NuqsAdapter>
          <StoreProvider>
            <AuthProvider>
              <I18nProvider language={lang}>
                <ThemeRegistry theme={theme as "light" | "dark"}>
                  <ToastProvider>
                    <AssistantRoot>{children}</AssistantRoot>
                  </ToastProvider>
                </ThemeRegistry>
              </I18nProvider>
            </AuthProvider>
          </StoreProvider>
        </NuqsAdapter>
      </body>
    </html>
  );
}
