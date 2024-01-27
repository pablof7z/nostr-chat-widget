<script>
  import { chatAdapter } from "./lib/store";
  import KeyPrompt from "./KeyPrompt.svelte";
  import ConnectedWidget from "./ConnectedWidget.svelte";

  export let startPage;
  export let websiteOwnerPubkey;
  export let chatStarted;
  export let chatConfiguration;
  export let relays;
  export let toggleChat;

  let editedStartPage = startPage;
  let editedStartPage2 = startPage;

  function firstStartupDone () {
    editedStartPage = "login";
  }

  function managedLogin () {
    editedStartPage2 = "login";
  }

  $: chatStarted = !!$chatAdapter;
</script>

{#if !chatStarted}
  <KeyPrompt {firstStartupDone} {managedLogin} startPage={editedStartPage} {toggleChat} {websiteOwnerPubkey} {chatConfiguration} {relays} />
{:else}
  <ConnectedWidget
    startPage={editedStartPage2}
    {toggleChat}
    {websiteOwnerPubkey}
    {chatConfiguration}
    {relays}
  />
{/if}

<style>
  @tailwind base;
  @tailwind components;
  @tailwind utilities;
</style>
