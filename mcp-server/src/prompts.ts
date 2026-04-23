import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer): void {
  // Weekly summary prompt
  server.prompt(
    'weekly-summary',
    'Generate a summary of activity across all domains for the past week',
    {},
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              'Please summarize my activity from the past week across all domains. Use the following tools to gather the data:',
              '',
              "1. get_recent_listens (limit 20) -- what I've been listening to",
              '2. get_recent_runs (limit 10) -- any runs this week',
              "3. get_recent_watches (limit 10) -- movies or TV I've watched",
              "4. get_recent_reads (limit 10) -- articles I've been reading",
              '5. get_feed (limit 30, from: 7 days ago) -- unified activity',
              '',
              'Organize the summary by domain. Highlight patterns, notable items, and any streaks or milestones.',
              'Keep the tone casual and reflective. Use specific names, numbers, and dates from the data.',
            ].join('\n'),
          },
        },
      ],
    })
  );

  // Year in review prompt
  server.prompt(
    'year-in-review',
    'Generate a comprehensive year-in-review for a given year across all domains',
    {
      year: z.string().describe('The year to review (e.g. 2025)'),
    },
    ({ year }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Generate a year-in-review for ${year}. Gather data from all domains:`,
              '',
              '1. get_listening_stats -- overall listening numbers',
              `2. get_top_artists (period: 12month, limit: 10) -- top artists`,
              `3. get_top_albums (period: 12month, limit: 10) -- top albums`,
              '4. get_running_stats -- running totals',
              '5. get_watching_stats -- movie and TV totals',
              '6. get_collecting_stats -- collection growth',
              '7. get_reading_stats -- reading numbers',
              '',
              `Create a comprehensive but concise year-in-review for ${year}. Include:`,
              '- Key stats and totals per domain',
              '- Standout items (most-played artist, longest run, favorite movie, etc.)',
              '- Interesting patterns or changes from previous years if apparent',
              '- A brief overall reflection',
              '',
              'Format it as a readable narrative, not just a list of numbers.',
            ].join('\n'),
          },
        },
      ],
    })
  );

  // Letterboxd review draft
  server.prompt(
    'letterboxd-review-draft',
    'Draft a Letterboxd-style review for a recently watched film that I have rated but not yet reviewed.',
    {
      title: z
        .string()
        .optional()
        .describe(
          'Optional film title to review. If omitted, picks the most recent unreviewed watch.'
        ),
    },
    ({ title }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              title
                ? `Draft a Letterboxd-style review for "${title}". First, call get_recent_watches (limit 20) to find its watch record and get the movie id. Then call get_movie_details to pull the full movie context plus my watch history and any rating.`
                : 'Draft a Letterboxd-style review for the most recent film I watched that has a user_rating but no review_url yet. Call get_recent_watches (limit 20) first to find the right candidate, then get_movie_details to pull the full context.',
              '',
              'Use the poster image from the response to inform tone and aesthetic observations.',
              'Write in my voice:',
              '- 2-4 short paragraphs, conversational but specific',
              '- Lead with a gut reaction, not a plot summary',
              '- Cite at least one specific craft detail (direction, shot, needle drop, performance)',
              '- Close with a concise take that justifies the rating',
              '- Avoid generic adjectives ("compelling", "powerful", "thought-provoking")',
              '',
              'Output only the review body -- no headline, no star rating, no metadata.',
            ].join('\n'),
          },
        },
      ],
    })
  );

  // Training report
  server.prompt(
    'training-report',
    'Analyze the past 7-14 days of running activity and produce a coach-style training report.',
    {
      days: z
        .string()
        .optional()
        .describe('Number of days to analyze (default 7).'),
    },
    ({ days }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Produce a training report covering the last ${days ?? '7'} days of running.`,
              '',
              'Gather:',
              `1. get_recent_runs with from set to ${days ?? '7'} days ago`,
              '2. get_running_stats for lifetime context',
              '3. get_running_streaks for streak state',
              '4. get_activity_splits on the longest run and any race in the window (use the IDs from step 1)',
              '5. get_running_years to compare the current year pace to last year if relevant',
              '',
              'Structure the report:',
              '- Headline: volume + intensity one-liner',
              '- Weekly mileage vs a reasonable baseline (past year or lifetime average)',
              '- Pace trend -- are splits on the long run holding pace, or drifting?',
              '- Elevation, HR, cadence if present on the long run',
              '- Streak status and whether to push or rest',
              '- One concrete suggestion for the next 7 days',
              '',
              'Be specific with numbers. Cite exact runs by name + date. No vague phrases like "good work" or "keep it up".',
            ].join('\n'),
          },
        },
      ],
    })
  );

  // Film diet
  server.prompt(
    'film-diet',
    'Characterize the shape of my movie-watching taste: genre mix, decade distribution, top directors, rewatch rate, and where I lean vs drift.',
    {
      period: z
        .string()
        .optional()
        .describe(
          "Optional period scope (e.g. '12month', '2025'). Default: lifetime."
        ),
    },
    ({ period }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Characterize the shape of my film-watching taste${period ? ` for ${period}` : ''}. This is a portrait, not a top-10 list.`,
              '',
              'Use the breakdown tools:',
              '1. get_watching_stats -- totals and top_* headlines',
              '2. get_watching_genres -- full genre percentage distribution',
              '3. get_watching_decades -- decade distribution',
              '4. get_watching_directors (limit 20) -- director frequency long tail',
              '',
              'Cover:',
              '- Genre mix: where is the weight? what is under-represented?',
              '- Decade profile: am I a classics person, a recent-releases person, or bimodal?',
              '- Directors: which are habitual (3+ films) vs one-offs? any obvious auteur loyalties?',
              '- Any interesting tensions (e.g. stated preferences vs actual pattern)',
              '',
              'Tone: honest, data-specific, avoid flattery. If the data shows a gap (e.g. almost no pre-1970 films) name it.',
              'Write as a short portrait, 3-5 tight paragraphs. Quote exact percentages and counts.',
            ].join('\n'),
          },
        },
      ],
    })
  );

  // Compare periods prompt
  server.prompt(
    'compare-periods',
    'Compare activity between two time periods for a specific domain',
    {
      domain: z
        .string()
        .describe(
          'Domain to compare (listening, running, watching, collecting, reading)'
        ),
      period1: z
        .string()
        .describe(
          "First period description (e.g. 'January 2025', 'last month')"
        ),
      period2: z
        .string()
        .describe(
          "Second period description (e.g. 'January 2024', 'this month')"
        ),
    },
    ({ domain, period1, period2 }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Compare my ${domain} activity between ${period1} and ${period2}.`,
              '',
              `Use the appropriate tools for the ${domain} domain to gather data for both periods.`,
              'For each period, get stats, recent activity, and any relevant top lists.',
              '',
              'Present the comparison as:',
              '- Side-by-side key metrics',
              '- Notable differences and trends',
              '- Standout items unique to each period',
              '',
              'Keep the analysis specific and data-driven.',
            ].join('\n'),
          },
        },
      ],
    })
  );

  // Find a half-remembered article
  server.prompt(
    'find-article',
    'Recover an article the user only half-remembers, using hybrid keyword + semantic search, then surface related pieces',
    {
      description: z
        .string()
        .describe(
          'Whatever the user remembers about the article: topic, person mentioned, feeling, rough time period, etc.'
        ),
    },
    ({ description }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Help me find this article I vaguely remember: "${description}"`,
              '',
              'Strategy:',
              "1. Call `search` with mode='hybrid', domain='reading', and the description as the query. Hybrid combines FTS for any exact keywords + semantic for paraphrased recall.",
              '2. If hybrid returns nothing useful, fall back to `semantic_search` which is pure-vector (better for very vague descriptions).',
              "3. For the top 2-3 candidates, fetch the `@rewind://article/{id}` resource to read the excerpt. Verify the excerpt actually supports the user's description before claiming a match.",
              '4. Only after verifying the match, call `find_similar_articles(article_id)` for related pieces.',
              '',
              'CRITICAL — do not hallucinate connecting facts:',
              "- If the excerpt does NOT clearly match the user's description, say so. Do not invent biographical details about the subject to make the article fit (e.g. claiming someone was a writer on SNL when the excerpt never says that).",
              '- When citing a specific fact, quote a short phrase from the excerpt so the user can see where it came from.',
              '- If no candidate clearly matches, present the top 2-3 with short excerpts and ask the user which one they meant (or say none seem to fit).',
              '- Do NOT use recent-reads recency as a tiebreaker when the content does not support the query. A semantically weak match from yesterday is worse than a strong match from a year ago.',
              '',
              'Present the answer as:',
              '- The confirmed match: render the title as a markdown link `[title](url)` (or `[title](instapaper_url)` if `url` is null), followed by author, source domain, and a one-sentence summary drawn verbatim from the excerpt',
              '- 3-5 related pieces, each also rendered as markdown links with the same `[title](url)` pattern (only if match is confirmed)',
              '',
              'Keep it concise — the user is trying to refind something, not read a review.',
            ].join('\n'),
          },
        },
      ],
    })
  );
}
