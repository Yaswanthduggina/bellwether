import { createSeedAdapter } from "./seedAdapter";

async function main() {
    const adapter = createSeedAdapter("INSTAGRAM");
    const posts = await adapter.fetchPosts("shashi_tharoor", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
    console.log(`Generated ${posts.length} posts`);
    console.log(posts[0]);
}

main();