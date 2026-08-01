import { postDone } from "../helper/workerLifecycle.js";
import process from "node:process";

console.log("Alive");

// signal to parent that the job is done
void postDone();
