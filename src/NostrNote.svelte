<script>
	import { selectedMessage } from './lib/store';
    import { chatData } from './lib/store';
    export let event;
    export let responses;
    export let websiteOwnerPubkey;

    let profiles = {};
    let profilePicture;

    function selectMessage() {
        if ($selectedMessage === event.id) {
            $selectedMessage = null;
        } else {
            $selectedMessage = event.id;
        }
    }

    const byWebsiteOwner = !!websiteOwnerPubkey === event.pubkey;

    $: profiles = $chatData.profiles;
    $: displayName = profiles[event.pubkey] && profiles[event.pubkey].display_name || `[${event.pubkey.slice(0, 6)}]`;
    $: nip05 = profiles[event.pubkey] && profiles[event.pubkey].nip05;

    $: profilePicture = profiles[event.pubkey] && profiles[event.pubkey].picture || `https://robohash.org/${event.pubkey}.png?set=set1`;

    const repliedIds = event.tags.filter(e => e[0] === 'e').map(e => e[1]);

    let timestamp = new Date(event.created_at * 1000);
</script>

<div
    class="
        block p-2-lg mb-3
        text-wrap
    "
>
    <div class="flex flex-row gap-4">
        <div class="min-w-fit">
            <img src="{profilePicture}" class="
                block w-10 h-10 rounded-full
                {byWebsiteOwner ? 'ring-purple-700 ring-4' : 'ring-gray-300 ring-2'}
            " alt="" />
            <!-- <span class="text-base font-semibold text-clip">{displayName}</span>
                {#if nip05}
                    <span class="text-sm text-gray-400">{nip05}</span>
                {/if} -->
        </div>

        <div class="w-full overflow-hidden">
            <div class="flex flex-row justify-between text-center overflow-clip text-clip w-full">
            </div>

            <div class="
                max-h-64 text-base
                cursor-pointer
                border border-slate-200
                {$selectedMessage === event.id ? 'bg-purple-700 text-white' : 'bg-slate-50 text-gray-500 hover:bg-slate-100'}
                p-4 py-2 overflow-auto rounded-2xl
            " on:click|preventDefault={()=>{selectMessage(event.id)}}>
                {event.content}
            </div>

            <div class="flex flex-row-reverse justify-between mt-1 overflow-clip items-center">
                <div class="text-xs text-gray-400 text-ellipsis overflow-clip whitespace-nowrap">
                    <span class="py-2">
                        {timestamp.toLocaleString()}
                    </span>
                </div>

                {#if byWebsiteOwner}
                    <div class="text-purple-500 text-xs">
                        Website owner
                    </div>
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
    <div class="pl-5 border-l border-l-gray-400 mb-10">
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