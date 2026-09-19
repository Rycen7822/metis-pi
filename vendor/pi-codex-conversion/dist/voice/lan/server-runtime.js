export async function collectFailures(promises, failures) {
    const settled = await Promise.allSettled(promises.filter((promise) => promise !== undefined));
    for (const result of settled)
        if (result.status === "rejected")
            failures.push(result.reason);
}
export function configureServer(server) {
    server.keepAliveTimeout = 20_000;
    server.on("tlsClientError", () => { });
    server.on("clientError", (_error, socket) => socket.destroy());
    server.on("error", () => { });
}
export function listen(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "0.0.0.0");
    });
}
export function lanVoiceUrls(hostnames, ipAddresses, port) {
    const hosts = [...hostnames.filter((value) => value !== "localhost"), ...ipAddresses.filter((value) => value !== "127.0.0.1")];
    if (hosts.length === 0)
        hosts.push("localhost");
    return [...new Set(hosts.map((host) => `https://${host}:${port}`))];
}
