import NstrAdapter from './index.js';

class NstrAdapterNip07 extends NstrAdapter {
    constructor(pubkey, adapterConfig={}) {
        super(pubkey, adapterConfig);
    }

    async signEvent(event) {
        return await window.nostr.signEvent(event);
    }

    async encrypt(destPubkey, message) {
        return await window.nostr.nip04.encrypt(destPubkey, message);
    }

    async decrypt(destPubkey, message) {
        return await window.nostr.nip04.decrypt(destPubkey, message);
    }
}

export default NstrAdapterNip07;
