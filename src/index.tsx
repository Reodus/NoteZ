/* @refresh reload */
import { render } from "solid-js/web";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { installBundledFonts } from "./core/fonts";

void installBundledFonts();

render(() => <App />, document.getElementById("root") as HTMLElement);
