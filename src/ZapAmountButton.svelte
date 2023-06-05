<script>
    export let icon, amount, amountDisplay, event, mobilePR;
    import { zappingMessage } from './lib/store';
    import NDK, { NDKEvent, NDKNip07Signer } from '@nostr-dev-kit/ndk';
    import { requestProvider } from 'webln';

    let hover = false;

    async function zap() {
        const signer = new NDKNip07Signer();
        const ndk = new NDK({ explicitRelayUrls: ['wss://nos.lol', 'wss://relay.nostr.band', 'wss://relay.damus.io', 'wss://nostr.mom', 'wss://no.str.cr'] });
        ndk.signer = signer;
        await ndk.connect();
        let pr;
        try {
            const ndkEvent = new NDKEvent(ndk, event);
            pr = await ndkEvent.zap(amount * 1000);
        } catch (e) {
            alert(e)
            return;
        }


        let webln;

        try {
            webln = await requestProvider();
        } catch (err) {
            mobilePR = pr;
            return;
        }

        try {
            await webln.sendPayment(pr);
            $zappingMessage = null;
        } catch (err) {
            mobilePR = pr;
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