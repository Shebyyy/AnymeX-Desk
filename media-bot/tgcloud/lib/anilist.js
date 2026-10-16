import { fetch } from 'sdk';

const ANILIST_API = 'https://graphql.anilist.co';

async function queryAnilist(query, variables = {}) {
  try {
    const res = await fetch(ANILIST_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      console.error('AniList API error:', res.status, await res.text().catch(() => ''));
      return null;
    }

    const data = await res.json();
    return data.data;
  } catch (err) {
    console.error('AniList network error:', err);
    return null;
  }
}

/**
 * Search Anime, Manga, or Light Novels.
 */
export async function searchMedia({ query, type = 'ANIME', format = null, page = 1, perPage = 5 }) {
  const gql = `
    query ($search: String, $type: MediaType, $format: MediaFormat, $page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo {
          total
          currentPage
          lastPage
          hasNextPage
        }
        media(search: $search, type: $type, format: $format, sort: POPULARITY_DESC) {
          id
          idMal
          title {
            romaji
            english
            native
          }
          type
          format
          status
          description(asHtml: false)
          seasonYear
          episodes
          chapters
          volumes
          averageScore
          genres
          coverImage {
            extraLarge
            large
            color
          }
          nextAiringEpisode {
            episode
            timeUntilAiring
          }
          siteUrl
        }
      }
    }
  `;

  const vars = { search: query, type, page, perPage };
  if (format) vars.format = format;

  const data = await queryAnilist(gql, vars);
  return data?.Page || { pageInfo: {}, media: [] };
}

/**
 * Get full details of a specific media by AniList ID.
 */
export async function getMediaById(id) {
  const gql = `
    query ($id: Int) {
      Media(id: $id) {
        id
        idMal
        title {
          romaji
          english
          native
        }
        type
        format
        status
        description(asHtml: false)
        season
        seasonYear
        episodes
        chapters
        volumes
        duration
        averageScore
        popularity
        genres
        studios(isMain: true) {
          nodes {
            name
          }
        }
        coverImage {
          extraLarge
          large
          color
        }
        bannerImage
        nextAiringEpisode {
          episode
          timeUntilAiring
        }
        siteUrl
      }
    }
  `;

  const data = await queryAnilist(gql, { id: Number(id) });
  return data?.Media || null;
}

/**
 * Get today's and upcoming airing anime schedule.
 */
export async function getAiringSchedule(perPage = 10) {
  const now = Math.floor(Date.now() / 1000);
  const endOfDay = now + 86400 * 2; // Next 48 hours

  const gql = `
    query ($now: Int, $end: Int, $perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        airingSchedules(airingAt_greater: $now, airingAt_lesser: $end, sort: TIME) {
          id
          airingAt
          episode
          timeUntilAiring
          media {
            id
            title {
              romaji
              english
            }
            format
            averageScore
            coverImage {
              large
            }
            siteUrl
          }
        }
      }
    }
  `;

  const data = await queryAnilist(gql, { now, end: endOfDay, perPage });
  return data?.Page?.airingSchedules || [];
}

/**
 * Fetch a user's currently watching / reading titles from AniList.
 */
export async function getUserCurrentList(username) {
  const gql = `
    query ($userName: String) {
      animeList: MediaListCollection(userName: $userName, type: ANIME, status: CURRENT) {
        lists {
          entries {
            media {
              id
              title {
                romaji
                english
              }
              type
              nextAiringEpisode {
                episode
                timeUntilAiring
              }
            }
          }
        }
      }
      mangaList: MediaListCollection(userName: $userName, type: MANGA, status: CURRENT) {
        lists {
          entries {
            media {
              id
              title {
                romaji
                english
              }
              type
              format
            }
          }
        }
      }
    }
  `;

  const data = await queryAnilist(gql, { userName: username });
  if (!data) return { anime: [], manga: [] };

  const animeEntries = data.animeList?.lists?.flatMap((l) => l.entries.map((e) => e.media)) || [];
  const mangaEntries = data.mangaList?.lists?.flatMap((l) => l.entries.map((e) => e.media)) || [];
  return { anime: animeEntries, manga: mangaEntries };
}
