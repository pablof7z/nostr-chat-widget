<script>
    export let icon, amount, amountDisplay, event;
    import { zappingMessage } from './lib/store';
    import NDK, { NDKEvent, NDKNip07Signer } from 'nostr-dev-kit';
    import { requestProvider } from 'webln';

    let hover = false;

    async function zap() {
        const signer = new NDKNip07Signer();
        const pubkey = await signer.configure(window);
        const ndk = new NDK({ explicitRelayUrls: ['wss://nos.lol', 'wss://relay.nostr.band', 'wss://relay.damus.io', 'wss://nostr.mom', 'wss://no.str.cr'] });
        ndk.signer = signer;
        await ndk.connect();
        const ndkEvent = new NDKEvent(ndk, event);
        const pr = await ndkEvent.zap(amount * 1000);

        try {
            const webln = await requestProvider();
            await webln.sendPayment(pr);
            $zappingMessage = null;
        } catch (err) {
            $zappingMessage = null;
            console.log(err);
        }
    }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<div
    on:mouseenter={() => (hover = true)}
    on:mouseleave={() => (hover = false)}
    on:click|preventDefault={zap}
>
    {#if !hover}
        <span class="text-xl">{icon}</span>
    {:else}
        <span class="text-base text-white flex flex-col items-center">
            {amountDisplay||amount}
        </span>
    {/if}
</div>