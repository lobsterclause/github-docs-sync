import { initializeApp } from "firebase-admin/app";

initializeApp();

export { syncDocsToDrive } from "./syncDocsToDrive.js";
export { syncDocsInitial } from "./syncDocsInitial.js";
export { syncDocsPR } from "./syncDocsPR.js";
