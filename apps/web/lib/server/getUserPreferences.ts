import { cookies, headers } from "next/headers";
import { getServerSession } from "next-auth";
import { options } from "@/app/api/auth/[...nextauth]/options";
import { getSystemSettings } from "@/lib/api/system/server";
import { fallbackLng } from "@/i18n/settings";
import { LANGUAGE_COOKIE_NAME, THEME_COOKIE_NAME } from "@/lib/constants";

export const getUserPreferencesForLayout = async () => {
    const c = await cookies();
    let lang = c.get(LANGUAGE_COOKIE_NAME)?.value;
    let theme = c.get(THEME_COOKIE_NAME)?.value;

    if (!lang || !theme) {
        const session = await getServerSession(options);
        if (session?.access_token) {
            try {
                const prefs = await getSystemSettings(
                    session.access_token,
                    (await headers()).get("accept-language")
                );
                lang = prefs?.preferred_language ?? fallbackLng;
                theme = prefs?.client_theme ?? "light";
            } catch (e) {
                console.error("Failed to fetch prefs", e);
            }
        }
        lang = lang ?? fallbackLng;
        theme = theme ?? "light";
    }

    return { lang, theme };
};