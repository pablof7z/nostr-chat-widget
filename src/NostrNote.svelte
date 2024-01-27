<script>
  import { afterUpdate, onMount } from "svelte";
  import { selectedMessage, zappingMessage, zapsPerMessage } from "./lib/store";
  import { chatData, chatAdapter } from "./lib/store";
  import { nip19 } from "nostr-tools";
  import ZapAmountButton from "./ZapAmountButton.svelte";
  // import { prettifyContent } from '$lib/utils';
  export let event;
  export let responses;
  export let websiteOwnerPubkey;

  let profiles = {};
  let profilePicture;
  let npub;
  let zappingIt;
  let hovering;
  let mobilePR;

  let zappedAmount = 0;

  function selectMessage() {
    if ($selectedMessage === event.id) {
      $selectedMessage = null;
    } else {
      $selectedMessage = event.id;
    }
  }

  // delay-fetch responses
  onMount(() => {
    $chatAdapter.delayedSubscribe(
      { kinds: [1, 42, 9735], "#e": [event.id] },
      "responses",
      500
    );
  });

  const byWebsiteOwner = !!websiteOwnerPubkey === event.pubkey;

  $: profiles = $chatData.profiles;
  $: displayName =
    (profiles[event.pubkey] && profiles[event.pubkey].display_name) ||
    `[${event.pubkey.slice(0, 6)}]`;
  // $: nip05 = profiles[event.pubkey] && profiles[event.pubkey].nip05;
  $: zappingIt = $zappingMessage === event.id;
  $: {
    try {
      npub = nip19.npubEncode(event.pubkey);
    } catch (e) {
      npub = event.pubkey;
    }
  }

  $chatAdapter.on("zap", () => {
    zappedAmount =
      $zapsPerMessage[event.id]?.reduce((acc, zap) => acc + zap.amount, 0) || 0;
  });

  $: {
    zappedAmount =
      $zapsPerMessage[event.id]?.reduce((acc, zap) => acc + zap.amount, 0) || 0;
  }

  afterUpdate(() => {
    zappedAmount =
      $zapsPerMessage[event.id]?.reduce((acc, zap) => acc + zap.amount, 0) || 0;
  });

  $: profilePicture =
    (profiles[event.pubkey] && profiles[event.pubkey].picture) ||
    `https://robohash.org/${event.pubkey.slice(0, 1)}.png?set=set1`;

  // const repliedIds = event.tags.filter(e => e[0] === 'e').map(e => e[1]);

  let timestamp = new Date(event.created_at * 1000);
</script>

<div
  class="
        flex flex-col gap-4
        p-2-lg mb-3
        text-wrap
        relative
    "
  on:mouseenter={() => (hovering = true)}
  on:mouseleave={() => (hovering = false)}
>
  <div class="flex flex-row gap-3">
    <div class="min-w-fit flex flex-col gap-2">
      <a href={`nostr:${npub}`}>
        <img
          src={profilePicture}
          class="
                    block w-8 h-8 rounded-full
                    {byWebsiteOwner ? 'ring-purple-700 ring-4' : ''}
                "
          alt=""
        />
      </a>

      <button
        class="
                        rounded-full
                        {zappedAmount > 0
          ? 'opacity-100 text-base'
          : 'bg-orange-500 opacity-10 text-xl'}
                        w-8 h-8
                        flex items-center
                        justify-center
                        hover:opacity-100
                    "
        on:click|preventDefault={() =>
          ($zappingMessage = $zappingMessage === event.id ? null : event.id)}
      >
        {#if zappedAmount > 0}
          <p class="flex flex-col items-center my-4">
            ⚡️
            <span class="text-orange-500 font-semibold">
              {zappedAmount / 1000}
            </span>
          </p>
        {:else}
          ⚡️
        {/if}
      </button>

      <div
        class="
                {zappingIt
          ? 'w-full rounded-full bg-white  drop-shadow-xl justify-between border-2 border-gray-200'
          : ' rounded-full w-8 h-8 justify-center'}
                flex items-center absolute ml-5 mt-10 z-10"
      >
        {#if zappingIt}
          {#if mobilePR}
            <div class="flex flex-col gap-3 w-full">
              <a
                href={`lightning:${mobilePR}`}
                class="text-center w-full p-3 bg-black text-white rounded-t-xl"
                >Open in wallet</a
              >
              <button
                class="bg-white rounder-b-xl p-3"
                on:click={() => {
                  $zappingMessage = null;
                }}
              >
                Cancel
              </button>
            </div>
          {:else}
            <div class="flex flex-row items-stretch justify-between w-full">
              <div
                class="flex flex-col hover:bg-orange-500 text-white rounded-full w-12 h-12 items-center justify-center cursor-pointer"
              >
                <ZapAmountButton icon="👍" amount={500} {event} bind:mobilePR />
              </div>
              <div
                class="flex flex-col hover:bg-orange-500 text-white rounded-full w-12 h-12 items-center justify-center cursor-pointer"
              >
                <ZapAmountButton
                  icon="🤙"
                  amount={2500}
                  amountDisplay={"2.5k"}
                  {event}
                  bind:mobilePR
                />
              </div>
              <div
                class="flex flex-col hover:bg-orange-500 text-white rounded-full w-12 h-12 items-center justify-center cursor-pointer"
              >
                <ZapAmountButton
                  icon="🙌"
                  amount={5000}
                  amountDisplay={"5k"}
                  {event}
                  bind:mobilePR
                />
              </div>
              <div
                class="flex flex-col hover:bg-orange-500 text-white rounded-full w-12 h-12 items-center justify-center cursor-pointer"
              >
                <ZapAmountButton
                  icon="🧡"
                  amount={10000}
                  amountDisplay={"10k"}
                  {event}
                  bind:mobilePR
                />
              </div>
              <div
                class="flex flex-col hover:bg-orange-500 text-white rounded-full w-12 h-12 items-center justify-center cursor-pointer"
              >
                <ZapAmountButton
                  icon="🤯"
                  amount={100000}
                  amountDisplay={"100k"}
                  {event}
                  bind:mobilePR
                />
              </div>
              <div
                class="flex flex-col hover:bg-orange-500 text-white rounded-full w-12 h-12 items-center justify-center cursor-pointer"
              >
                <ZapAmountButton
                  icon="😎"
                  amount={1000000}
                  amountDisplay={"1M"}
                  {event}
                  bind:mobilePR
                />
              </div>
            </div>
          {/if}
        {/if}
      </div>

      <!-- <span class="text-base font-semibold text-clip">{displayName}</span>
                {#if nip05}
                    <span class="text-sm text-gray-400">{nip05}</span>
                {/if} -->
    </div>

    <div class="w-full overflow-hidden">
      <div
        class="flex flex-row justify-between text-center overflow-clip text-clip w-full"
      />

      <div
        class="
                max-h-64 text-base
                cursor-pointer
                border border-slate-200
                {$selectedMessage === event.id
          ? 'bg-purple-700 text-white'
          : 'bg-white text-gray-900 hover:bg-slate-100'}
                p-4 py-2 overflow-auto rounded-2xl
                shadow-sm
            "
        on:click|preventDefault={() => {
          selectMessage(event.id);
        }}
        on:keydown|preventDefault={() => {
          selectMessage(event.id);
        }}
        on:keyup|preventDefault={() => {
          selectMessage(event.id);
        }}
      >
        {event.content}
      </div>

      <div
        class="flex flex-row-reverse justify-between mt-1 overflow-clip items-center relative"
      >
        <div
          class="text-xs text-gray-400 text-ellipsis overflow-clip whitespace-nowrap"
        >
          <span class="py-2">
            {timestamp.toLocaleString()}
          </span>
        </div>

        {#if byWebsiteOwner}
          <div class="text-purple-500 text-xs">Website owner</div>
        {:else}
          <div class="text-xs text-gray-400">
            {displayName}
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

{#if responses[event.id].length > 0}
  <div class="pl-5 border-l border-l-gray-400 flex flex-col gap-4">
    {#each responses[event.id] as response}
      <svelte:self {websiteOwnerPubkey} event={response} {responses} />
    {/each}
  </div>
{/if}

<style>
  @tailwind base;
  @tailwind components;
  @tailwind utilities;
</style>
