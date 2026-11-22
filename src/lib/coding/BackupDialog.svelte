<script lang="ts">
  import { Dialog } from "bits-ui";
  import "material-symbols/rounded.css";
  import { BACKUP_DEFAULT, type BackupPrefs } from "$lib/coding/backup.svelte";

  /**
   * The coding bar's backup pill + dialog: how many newly coded entries trigger
   * an automatic project backup (JSON download); 0 disables the feature.
   */
  let { prefs }: { prefs: BackupPrefs } = $props();

  let open = $state(false);
  let draft = $state("");
  // pre-fill the input on every open (the stored value may change meanwhile)
  $effect(() => {
    if (open) draft = String(prefs.every);
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger class="pill" title="Automatic project backup settings">
    <span class="material-symbols-rounded" aria-hidden="true">settings_backup_restore</span>Backup
  </Dialog.Trigger>
  <Dialog.Overlay class="dlg-overlay" />
  <Dialog.Content class="dlg dlg-backup" aria-label="Auto backup settings">
    <p class="bkhint">
      Every <b>{BACKUP_DEFAULT}</b> newly coded entries the app downloads a backup of the current project (JSON)
      automatically. Set <b>0</b> to disable this.
    </p>
    <div class="bkrow">
      <label class="bklabel" for="bkcount">Auto backup every</label>
      <input
        id="bkcount"
        class="bkinput"
        type="number"
        min="0"
        max="100000"
        step="1"
        bind:value={draft}
        aria-label="Auto backup every N codings (0 disables)"
      />
      <span class="bkunit">codings</span>
    </div>
    <div class="bkfoot">
      <button
        type="button"
        class="bksave"
        disabled={!Number.isInteger(Number(draft)) || Number(draft) < 0}
        onclick={() => prefs.setEvery(Number(draft))}
      >
        Save
      </button>
      {#if prefs.every === 0}<span class="bkoff">disabled</span>{/if}
    </div>
  </Dialog.Content>
</Dialog.Root>

<style lang="scss">
  :global(.dlg-backup) {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 41;
    width: min(26rem, 92vw);
    padding: 1.1rem 1.3rem;
    border: 1px solid var(--outline, #888);
    border-radius: 12px;
    background: var(--surface, white);
    color: var(--on-surface, #1c1b1f);
  }
  .bkhint {
    font-size: 0.85rem;
    color: var(--on-surface-variant, #666);
    margin: 0.2rem 0 0.8rem;
  }
  .bkrow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .bklabel {
    font-size: 0.9rem;
    font-weight: 600;
  }
  .bkinput {
    font: inherit;
    width: 6rem;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--outline, #888);
    border-radius: 8px;
    background: var(--surface, white);
    color: var(--on-surface, #111);
  }
  .bkunit {
    font-size: 0.85rem;
    color: var(--on-surface-variant, #666);
  }
  .bkfoot {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.9rem;
  }
  .bksave {
    font: inherit;
    font-size: 0.85rem;
    padding: 0.3rem 0.9rem;
    border-radius: 999px;
    border: 1px solid var(--primary, #6750a4);
    background: var(--primary, #6750a4);
    color: var(--on-primary, white);
    cursor: pointer;

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  }
  .bkoff {
    font-size: 0.8rem;
    color: #b3261e;
  }
</style>
