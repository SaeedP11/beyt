// Android's online translation: words and lines go to the Google Translate
// app, which translates them in a popup over Beyt. No key or account needed.

import { api } from "./api";
import { t } from "./i18n";
import { toast } from "./ui";

/** Translates `text`, written in `lang`, into Persian, or English for Persian text. */
export function translateExternally(text: string, lang: string): void {
  api.translateExternally(text, lang === "fa" ? "en" : "fa").catch(() => toast(t("noTranslator"), 5000));
}
