// A bunch of shit we can call from the client, we will make OpenAI calls from here

function handler(_req) {
    const headers = new Headers({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    });

    return new Response("Hello, World! This is served locally", { headers });
}

Deno.serve({ port: 8000 }, handler);