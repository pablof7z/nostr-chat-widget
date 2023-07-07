<script>
  import { onMount } from "svelte";
  // import QR from 'svelte-qr';
  import { chatAdapter } from "./lib/store";
  import NstrAdapterNip07 from "./lib/adapters/nip07.js";
  import NstrAdapterNip46 from "./lib/adapters/nip46.js";
  import NstrAdapterDiscadableKeys from "./lib/adapters/discardable-keys.js";

  export let websiteOwnerPubkey;
  export let chatConfiguration;
  export let relays;
  export let toggleChat;

  let hasNostrNip07 = true;
  let publicKey = null;
  let nip46URI;
  let adapterConfig;

  onMount(() => {
    // hasNostrNip07 = !!window.nostr;

    const type = localStorage.getItem("nostrichat-type");

    if (type === "nip07") {
      useNip07();
    } else if (type === "nip-46") {
      useNip46();
    }

    adapterConfig = {
      type: chatConfiguration.chatType,
      tags: chatConfiguration.chatTags,
      referenceTags: chatConfiguration.chatReferenceTags,
      websiteOwnerPubkey,
      relays,
    };
  });

  function useNip07() {
    window.nostr.getPublicKey().then((pubkey) => {
      localStorage.setItem("nostrichat-type", "nip07");
      chatAdapter.set(new NstrAdapterNip07(pubkey, adapterConfig));
    });
  }

  import { generatePrivateKey, getPublicKey } from "nostr-tools";
  import { Connect, ConnectURI } from "@nostr-connect/connect";

  async function useDiscardableKeys() {
    chatAdapter.set(new NstrAdapterDiscadableKeys(adapterConfig));
  }

  async function useNip46() {
    let key = localStorage.getItem("nostrichat-nostr-connect-key");
    let publicKey = localStorage.getItem("nostrichat-nostr-connect-public-key");

    if (key) {
      chatAdapter.set(new NstrAdapterNip46(publicKey, key, adapterConfig));
      return;
    }

    key = generatePrivateKey();

    const connect = new Connect({
      secretKey: key,
      relay: "wss://nostr.vulpem.com",
    });
    connect.events.on("connect", (connectedPubKey) => {
      localStorage.setItem("nostrichat-nostr-connect-key", key);
      localStorage.setItem(
        "nostrichat-nostr-connect-public-key",
        connectedPubKey
      );
      localStorage.setItem("nostrichat-type", "nip-46");

      console.log("connected to nostr connect relay");
      publicKey = connectedPubKey;
      chatAdapter.set(new NstrAdapterNip46(publicKey, key));
      nip46URI = null;
    });
    connect.events.on("disconnect", () => {
      console.log("disconnected from nostr connect relay");
    });
    await connect.init();

    let windowTitle, currentUrl, currentDomain;

    try {
      windowTitle = window.document.title || "Nostrichat";
      currentUrl = new URL(window.location.href);
      currentDomain = currentUrl.hostname;
    } catch (e) {
      currentUrl = window.location.href;
      currentDomain = currentUrl;
    }

    const connectURI = new ConnectURI({
      target: getPublicKey(key),
      relay: "wss://nostr.vulpem.com",
      metadata: {
        name: windowTitle,
        description: "🔉🔉🔉",
        url: currentUrl,
      },
    });

    nip46URI = connectURI.toString();
  }

  function Nip46Copy() {
    navigator.clipboard.writeText(nip46URI);
  }
</script>

<div
  class="flex justify-between items-center p-4 bg-purple-700 text-white md:rounded-t-md"
>
  <h3 class="m-0 text-lg">How whould you like to connect?</h3>
  <button
    id="close-popup"
    on:click={toggleChat}
    class="bg-transparent border-none text-white cursor-pointer"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="h-6 w-6"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      stroke-width="2"
      style="--darkreader-inline-stroke: currentColor;"
      data-darkreader-inline-stroke=""
      ><path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M6 18L18 6M6 6l12 12"
      /></svg
    >
  </button>
</div>

<div class="flex-1 p-4 overflow-y-auto">
  {#if publicKey}
    <p class="text-gray-400 mb-3 font-bold">
      Nostr Connect is a WIP, not fully implemented yet!
    </p>

    <p class="text-gray-400 mb-3">
      You are currently connected with the following public key:
      <span>{publicKey}</span>
    </p>
  {/if}

  {#if nip46URI}
    <p class="text-gray-600 mb-3">
      Scan this with your Nostr Connect (click to copy to clipboard)
    </p>

    <div class="bg-white w-full p-3" on:click|preventDefault={Nip46Copy}>
      <!-- <QR text={nip46URI} /> -->
    </div>

    <button class="bg-purple-800 hover:bg-purple-700 w-full p-2 rounded-xl text-center font-regular text-white"
      on:click|preventDefault={() => {
        nip46URI = null;
      }}
    >
      Cancel
    </button>
  {:else if !publicKey}
    <div class="flex flex-col gap-1">
      {#if hasNostrNip07}
        <button class="bg-purple-800 hover:bg-purple-700 w-full p-4 rounded-xl text-center font-regular text-gray-200"
          on:click|preventDefault={useNip07}
        >
          Browser Extension (NIP-07)
        </button>
      {/if}

      <button class="bg-purple-800 hover:bg-purple-700 w-full p-4 rounded-xl text-center font-regular text-gray-200"
        on:click|preventDefault={useNip46}
      >
        Nostr Connect (NIP-46)
      </button>

      <button class="bg-purple-800 hover:bg-purple-700 w-full p-4 rounded-xl text-center font-regular text-gray-200"
        on:click|preventDefault={useDiscardableKeys}
      >
        Anonymous
        <span class="text-xs text-gray-300"> (Ephemeral Keys) </span>
      </button>
    </div>
  {/if}
</div>

<style>
  @tailwind base;
  @tailwind components;
  @tailwind utilities;
</style>
