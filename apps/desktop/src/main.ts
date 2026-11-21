import "material-symbols/rounded.css";
import "./styles/app.css";
import App from "./App.svelte";
import { mount } from "svelte";

const app = mount(App, {
  target: document.getElementById("app") as HTMLElement
});

export default app;
