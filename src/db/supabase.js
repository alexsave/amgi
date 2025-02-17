import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.REACT_APP_SUPABASE_KEY
);

// Load all decks for the current user
export const loadDecks = async (userId) => {
  try {
    const { data: decks, error } = await supabase
      .from('decks')
      .select(`
        id,
        name,
        created_at,
        cards (
          id,
          front_text,
          back_text,
          front_audio_url,
          back_audio_url,
          created_at
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Convert array to object with deck IDs as keys
    return decks.reduce((acc, deck) => {
      acc[deck.id] = {
        ...deck,
        /*cards: deck.cards.reduce((cardAcc, card) => {
          cardAcc[card.id] = card;
          return cardAcc;
        }, {})*/
      };
      return acc;
    }, {});

  } catch (err) {
    console.error('Error loading decks:', err);
    return {};
  }
};

// Save a new deck or update an existing one
export const saveDeck = async (deck, userId) => {
  try {
    const { data, error } = await supabase
      .from('decks')
      .upsert({
        id: deck.id,
        name: deck.name,
        user_id: userId,
        created_at: deck.created_at || new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (err) {
    console.error('Error saving deck:', err);
    throw err;
  }
};

// Save a new card or update an existing one
export const saveCard = async (deckId, card) => {
  console.log('Supabase: saving card:', card);
  try {
    const { data, error } = await supabase
      .from('cards')
      .upsert({
        id: card.id,
        deck_id: deckId,
        front_text: card.front_text,
        back_text: card.back_text,
        front_audio_url: card.front_audio_url,
        back_audio_url: card.back_audio_url,
        created_at: card.created_at || new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (err) {
    console.error('Error saving card:', err);
    throw err;
  }
};

// Save multiple cards at once
export const saveCards = async (deckId, cards) => {
  try {
    const cardsArray = Object.values(cards).map(card => ({
      id: card.id,
      deck_id: deckId,
      front_text: card.front_text,
      back_text: card.back_text,
      front_audio_url: card.front_audio_url,
      back_audio_url: card.back_audio_url,
      created_at: card.created_at || new Date().toISOString()
    }));

    const { data, error } = await supabase
      .from('cards')
      .upsert(cardsArray)
      .select();

    if (error) throw error;
    return data;
  } catch (err) {
    console.error('Error saving cards:', err);
    throw err;
  }
};

// Delete a deck and all its cards
export const deleteDeck = async (deckId, userId) => {
  try {
    const { error } = await supabase
      .from('decks')
      .delete()
      .eq('id', deckId)
      .eq('user_id', userId);

    if (error) throw error;
  } catch (err) {
    console.error('Error deleting deck:', err);
    throw err;
  }
};

// Load review data for a card
export const loadReview = async (cardId, userId) => {
  try {
    const { data, error } = await supabase
      .from('reviews')
      .select()
      .eq('card_id', cardId)
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 is "no rows returned"
    return data;
  } catch (err) {
    console.error('Error loading review:', err);
    return null;
  }
};

// Save review data for a card
export const saveReview = async (cardId, review, userId) => {
  try {
    const { data, error } = await supabase
      .from('reviews')
      .upsert({
        card_id: cardId,
        user_id: userId,
        scheduled_date: review.scheduled_date,
        interval_days: review.interval_days,
        ease_factor: review.ease_factor,
        repetitions: review.repetitions,
        last_reviewed_at: review.last_reviewed_at || new Date().toISOString(),
        next_review_date: review.next_review_date
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (err) {
    console.error('Error saving review:', err);
    throw err;
  }
};

// Get cards due for review
export const getDueCards = async (userId) => {
  try {
    const { data: reviews, error } = await supabase
      .from('reviews')
      .select(`
        card_id,
        interval_days,
        ease_factor,
        repetitions,
        cards (
          id,
          deck_id,
          front_text,
          back_text,
          front_audio_url,
          back_audio_url
        )
      `)
      .eq('user_id', userId)
      .lte('next_review_date', new Date().toISOString().split('T')[0])
      .order('next_review_date', { ascending: true });

    if (error) throw error;

    return reviews.map(review => ({
      ...review.cards,
      review: {
        interval_days: review.interval_days,
        ease_factor: review.ease_factor,
        repetitions: review.repetitions
      }
    }));
  } catch (err) {
    console.error('Error getting due cards:', err);
    return [];
  }
}; 