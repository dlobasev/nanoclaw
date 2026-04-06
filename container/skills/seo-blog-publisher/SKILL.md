---
name: seo-blog-publisher
description: Research keywords, generate SEO-optimized blog posts for Astro sites, and publish to GitHub. Use when the user asks to write a blog post, article, or content for any of their sites.
---

# SEO Blog Publisher

You can research keywords, write SEO-optimized blog posts, and publish them to GitHub where they auto-deploy.

## Blog repositories

Check the group's CLAUDE.md for the `## Blogs` section. It lists available blogs with their repo URLs, post directories, audiences, and languages.

## Workflow

### Phase 1: Research keywords

When the user asks for a blog post:
1. Identify which blog (ask if unclear)
2. Use WebSearch to research:
   - Primary keywords and search volume signals
   - LSI (Latent Semantic Indexing) terms
   - People Also Ask questions
   - Search intent (informational, commercial, transactional)
   - Competitor content angles (what's already ranking)
3. Present a brief keyword plan to the user before writing

### Phase 2: Clone and analyze existing content

```bash
git clone https://x-access-token:${GITHUB_TOKEN}@github.com/OWNER/REPO.git /workspace/group/blog --depth 1 --branch master
```

Then:
1. Read all `.md` files in the posts directory
2. Extract frontmatter from each: titles, descriptions, tags, slugs
3. Build a topic map for internal linking opportunities
4. Identify 3-5 existing posts to link TO from the new article
5. Identify existing posts that should link BACK to the new article

### Phase 3: Determine frontmatter format

**Do not assume or hardcode the frontmatter format.** Instead:
1. Read 2-3 recent posts from the same blog
2. Extract the exact frontmatter fields, types, and patterns
3. Use that exact format for the new post

### Phase 4: Write the post

Create the `.md` file with:
- Frontmatter matching the blog's format exactly
- SEO-optimized title (include primary keyword naturally)
- Meta description (150-160 chars, includes primary keyword)
- Content that is genuinely interesting to the target audience
- 3-5 internal links woven naturally into the text
- Proper heading hierarchy (H2, H3)
- The primary keyword in the first paragraph
- LSI terms distributed throughout

**Writing quality rules:**
- Follow ALL writing rules from global CLAUDE.md (no em dashes, no AI smell, etc.)
- Write for the specific audience defined in the blog config
- Use the blog's language (en or ru)
- Make it interesting FIRST, SEO-friendly SECOND
- Real insights and specific examples beat generic advice

### Phase 5: Get approval

Send the draft to the user via `send_message`:
- Show the full title and meta description
- List the target keywords and LSI terms used
- List internal links (new → existing) and reverse links (existing → new)
- Include the full article text

Wait for user response:
- **Approval**: proceed to publish
- **Revisions**: apply changes and re-send
- **Reject**: discard and explain what went wrong

### Phase 6: Publish

```bash
cd /workspace/group/blog
git add .
git commit -m "blog: add [post-slug]"
git push origin master
```

After push:
1. Confirm publication via `send_message` with the expected URL
2. If reverse links were identified, create a separate commit updating those existing posts
3. Note: GitHub Actions will auto-deploy the site

## Git authentication

Use the `GITHUB_TOKEN` environment variable for HTTPS clone/push:
```bash
git clone https://x-access-token:${GITHUB_TOKEN}@github.com/owner/repo.git
```

Configure git identity before committing:
```bash
git config user.email "yuna@nanoclaw"
git config user.name "Yuna"
```

## Rules

- Never publish without explicit user approval
- Always show the draft first
- Always analyze existing content for cross-linking
- Always use the blog's actual frontmatter format (read existing posts)
- Keep slugs lowercase, hyphenated, descriptive
- Include the blog's base_url when confirming publication
