export function prettifyContent(content) {
    const bitcoinImage = "<img src=\"https://abs.twimg.com/hashflags/Bitcoin_evergreen/Bitcoin_evergreen.png\" style=\"width: 1.2em; vertical-align: -20%; margin-right: 0.075em; height: 1.2em; margin-left: 2px; display: inline-block;\">";

    return content
        .replace(/#bitcoin/i, `#bitcoin${bitcoinImage}`);
}