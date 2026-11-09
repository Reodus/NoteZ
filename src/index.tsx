/* @refresh reload */
import { render } from "solid-js/web";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { installBundledFonts } from "./core/fonts";
import { applyUiLanguage } from "./core/i18n";

applyUiLanguage();

void installBundledFonts();

render(() => <App />, document.getElementById("root") as HTMLElement);
