import { generatePrivateKey, signEvent, getPublicKey, nip04 } from 'nostr-tools';
import NstrAdapter from './index.js';

class NstrAdapterDiscadableKeys extends NstrAdapter {
    #privateKey;

    constructor(adapterConfig={}) {
        let key = localStorage.getItem('nostrichat-discardable-key');
        let publicKey = localStorage.getItem('nostrichat-discardable-public-key');

        if (!key) {
            key = generatePrivateKey();
            console.log('generated key', key);
            publicKey = getPublicKey(key);
        }

        localStorage.setItem('nostrichat-discardable-key', key);
        localStorage.setItem('nostrichat-discardable-public-key', publicKey);

        super(publicKey, adapterConfig);
        
        this.#privateKey = key;
        console.log(key);
    }

    async signEvent(event) {
        event.sig = await signEvent(event, this.#privateKey);
        return event;
    }

    async encrypt(destPubkey, message) {
        console.log(this.#privateKey);
        return await nip04.encrypt(this.#privateKey, destPubkey, message);
    }

    async decrypt(destPubkey, message) {
        return await nip04.decrypt(this.#privateKey, destPubkey, message);
    }
}

export default NstrAdapterDiscadableKeys;
