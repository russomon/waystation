# Branch Retirements

> **History, not state.** Records branches proposed for retirement and the evidence checked, so a deletion is recoverable. Whether a retirement has actually been performed is stated in `CURRENT_WORK.md` and `NEXT_STEPS.md`, not here.

## `codex/hosted-cloud-control`

- **Full SHA**: `564d55e5abd4d85998e6f21a8689d8d1a56ca572`, "Show hosted cloud compute selection", 2026-08-04, one commit unique to the branch. Local and `origin/codex/hosted-cloud-control` both pointed at it when checked (2026-10-06).
- **Files**: `client/index.html` and `client/src/main.ts` only (9 lines).
- **Behavior**: when a hosted deployment forces the compute target (`FORCED_COMPUTE`), keep the "Cloud compute" checkbox visible, checked and disabled with a tooltip, instead of hiding it; reword the checkbox label to "hosted worker is selected for this delivery". Client-only; the gateway already enforces the route.
- **Comparison against `main` (`452812c`)**: the behavior is already present on `main`, introduced by `61b0105` "Consolidate interpretive AI and local cloud routing" and recorded in `docs/DECISIONS_HISTORY.md` (2026-08-03, "forced-compute builds keep the same control visible but disabled"). Line by line, the checkbox's `checked` default (`client/index.html:469`) and the checked/disabled/tooltip logic (`client/src/main.ts:230-235`) match. Absent from `main`: the new label wording and one code comment. The wording is static text, so it would also be shown on deployments that do not force cloud compute and would then be misleading. `git cherry` lists the commit as not patch-equivalent only because `main` implemented it differently.
- **Conclusion**: superseded; no unique useful work.
- **Worktree**: registered at `/private/tmp/waystation-hosted-cloud.ZvAK2M`, directory missing, reported `prunable`.
- **Recovery**: an annotated tag `archive/hosted-cloud-control` pointing at exactly `564d55e5abd4d85998e6f21a8689d8d1a56ca572` is created and pushed before the branch is deleted (see Results). To restore the branch: `git fetch origin tag archive/hosted-cloud-control && git branch codex/hosted-cloud-control archive/hosted-cloud-control`. If the tag is ever lost, re-apply the patch below (`git diff 564d55e~1 564d55e`; whitespace-only context lines emptied) to a branch from the parent `ab1566843ee266f96a2f5a741f0b3dd5e1b94105`, or restore from any clone that still has the commit.

```diff
diff --git a/client/index.html b/client/index.html
index cab2293..a1f5ee3 100644
--- a/client/index.html
+++ b/client/index.html
@@ -149,8 +149,8 @@
             Preview thumbnail <span class="muted">poster frame</span></label>
           <label class="svc"><input type="checkbox" id="opt_summarize" checked />
             AI summary <span class="muted">GMI Cloud</span></label>
-          <label class="svc"><input type="checkbox" id="opt_cloud" />
-            Cloud compute <span class="muted">process at the Docker worker &middot; off = this machine</span></label>
+          <label class="svc"><input type="checkbox" id="opt_cloud" checked />
+            Cloud compute <span class="muted">hosted worker is selected for this delivery</span></label>
         </div>

         <button id="send" class="btn" disabled>Send</button>
diff --git a/client/src/main.ts b/client/src/main.ts
index 5dd9a23..63d8524 100644
--- a/client/src/main.ts
+++ b/client/src/main.ts
@@ -93,14 +93,14 @@ if (tid) {
   // "Transfer only" greys out and overrides the individual services.
   transferOnly.onchange = () => servicesEl.classList.toggle("off", transferOnly.checked);

-  // All-cloud deployments pin the compute target and hide the selector: the
-  // gateway and worker share one host, so there is no second machine to route
-  // to and a visible toggle would imply a choice that does not exist. The
-  // gateway enforces this independently — hiding a control is never the
-  // enforcement.
+  // All-cloud deployments pin the compute target but keep the selected route
+  // visible. The backend remains authoritative: the hosted worker is the only
+  // available destination even if a crafted request asks for another route.
   if (FORCED_COMPUTE) {
-    const row = $<HTMLInputElement>("#opt_cloud").closest("label");
-    if (row) (row as HTMLElement).hidden = true;
+    const cloud = $<HTMLInputElement>("#opt_cloud");
+    cloud.checked = FORCED_COMPUTE === "cloud";
+    cloud.disabled = true;
+    cloud.closest("label")?.setAttribute("title", `This deployment requires ${FORCED_COMPUTE} compute`);
   }

   const currentOptions = (): ServiceOptions => {
```

## Results

PENDING — to be recorded after the retirement sequence runs.
