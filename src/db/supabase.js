import { getLocalDate } from '../utils/dates';
import supabase from './supabaseClient';

// Load all decks for the current user
const loadNewCards = async (userId) => {
  const { data: decks, error } = await supabase
    .from('decks')
    .select(`
      id,
      cards!inner (
        id,
        front_text,
        back_text,
        front_audio_path,
        back_audio_path,
        front_lang,
        back_lang,
        position,
        created_at,
        reviews!inner (
          interval_days,
          ease_factor,
          repetitions,
          next_review_date,
          card_state
        )
      )
    `)
    .eq('user_id', userId)
    .eq('cards.reviews.card_state', 'new')
    .order('position', { referencedTable: 'cards', ascending: true })
    .limit(40, { foreignTable: 'cards' });

  if (error) throw error;
  return decks.reduce((acc, deck) => {
    acc[deck.id] = deck.cards.map(card => ({
      ...card,
      review: card.reviews[0],
      reviews: undefined
    }));
    return acc;
  }, {});
};

const loadLearningCards = async (userId) => {
  const { data: decks, error } = await supabase
    .from('decks')
    .select(`
      id,
      cards!inner (
        id,
        front_text,
        back_text,
        front_audio_path,
        back_audio_path,
        front_lang,
        back_lang,
        position,
        created_at,
        reviews!inner (
          interval_days,
          ease_factor,
          repetitions,
          next_review_date,
          card_state
        )
      )
    `)
    .eq('user_id', userId)
    .eq('cards.reviews.card_state', 'learning')
    .order('next_review_date', { referencedTable: 'cards.reviews', ascending: true });

  if (error) throw error;
  return decks.reduce((acc, deck) => {
    acc[deck.id] = deck.cards.map(card => ({
      ...card,
      review: card.reviews[0],
      reviews: undefined
    }));
    return acc;
  }, {});
};

const loadDueCards = async (userId) => {
  const today = getLocalDate();
  const { data: decks, error } = await supabase
    .from('decks')
    .select(`
      id,
      cards!inner (
        id,
        front_text,
        back_text,
        front_audio_path,
        back_audio_path,
        front_lang,
        back_lang,
        position,
        created_at,
        reviews!inner (
          interval_days,
          ease_factor,
          repetitions,
          next_review_date,
          card_state
        )
      )
    `)
    .eq('user_id', userId)
    .eq('cards.reviews.card_state', 'review')
    .lte('cards.reviews.next_review_date', today)
    .order('next_review_date', { referencedTable: 'cards.reviews', ascending: true });

  if (error) throw error;
  return decks.reduce((acc, deck) => {
    acc[deck.id] = deck.cards.map(card => ({
      ...card,
      review: card.reviews[0],
      reviews: undefined
    }));
    return acc;
  }, {});
};

export const loadDecks = async (userId) => {
  try {
    // Get basic deck info
    const { data: decks, error: decksError } = await supabase
      .from('decks')
      .select('id, name, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (decksError) throw decksError;

    // Load all card types in parallel
    const [newCardsByDeck, learningCardsByDeck, dueCardsByDeck] = await Promise.all([
      loadNewCards(userId),
      loadLearningCards(userId),
      loadDueCards(userId)
    ]);

    // Combine everything
    return decks.reduce((acc, deck) => {
      const newCards = newCardsByDeck[deck.id] || [];
      const learningCards = learningCardsByDeck[deck.id] || [];
      const dueCards = dueCardsByDeck[deck.id] || [];
      
      acc[deck.id] = {
        ...deck,
        //learningCards: learningCards,
        //newCards: newCards,
        //dueCards: dueCards,
        cards: [...learningCards, ...newCards, ...dueCards] // Priority order
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
    // If this is a new card being inserted at a specific position,
    // we need to shift existing cards to make room
    if (!card.id && card.position !== undefined) {
      console.log('Supabase: shifting cards to make room for new card');
      const { data: existingCards, error: shiftError } = await supabase
        .from('cards')
        .select('id, position')
        .eq('deck_id', deckId)
        .gte('position', card.position)
        .order('position');

      if (shiftError) throw shiftError;

      // Shift existing cards up by 1
      if (existingCards?.length > 0) {
        const updates = existingCards.map(existing => ({
          id: existing.id,
          position: existing.position + 1
        }));
        
        const { error: updateError } = await supabase
          .from('cards')
          .upsert(updates);

        if (updateError) throw updateError;
      }
    }

    // If no position specified for new card, put it at the end
    if (!card.id && card.position === undefined) {
      console.log('Supabase: getting last card position');
      const { data: lastCard, error: lastError } = await supabase
        .from('cards')
        .select('position')
        .eq('deck_id', deckId)
        .order('position', { ascending: false })
        .limit(1);

      if (lastError && lastError.code !== 'PGRST116') throw lastError;
      card.position = (lastCard[0]?.position || 0) + 1;
    }

    console.log('Supabase: inserting card');
    const { data, error } = await supabase
      .from('cards')
      .upsert({
        id: card.id,
        deck_id: deckId,
        position: card.position,
        front_text: card.front_text,
        back_text: card.back_text,
        front_audio_path: card.front_audio_path,
        back_audio_path: card.back_audio_path,
        front_lang: card.front_lang,
        back_lang: card.back_lang,
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
    // Get the highest position currently in use
    const { data: lastCard, error: lastError } = await supabase
      .from('cards')
      .select('position')
      .eq('deck_id', deckId)
      .order('position', { ascending: false })
      .limit(1)
      .single();

    if (lastError && lastError.code !== 'PGRST116') throw lastError;
    let nextPosition = (lastCard?.position || 0) + 1;

    const cardsArray = Object.values(cards).map(card => ({
      id: card.id,
      deck_id: deckId,
      position: card.position || nextPosition++,
      front_text: card.front_text,
      back_text: card.back_text,
      front_audio_path: card.frontAudioPath,
      back_audio_path: card.backAudioPath,
      front_lang: card.front_lang,
      back_lang: card.back_lang,
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

export const newReview = async (cardId, userId) => {
  const today = getLocalDate();

  console.log('Supabase: creating new review');
  const { data, error } = await supabase
    .from('reviews')
    .insert({
      card_id: cardId,
      user_id: userId,
      scheduled_date: today,
      interval_days: 1,
      ease_factor: 2.5,
      repetitions: 0,
      card_state: 'new',
      //next_review_date: new Date().toISOString()
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Save review data for a card
// assume we already have it
export const saveReview = async (cardId, review, userId) => {
  console.log('Saving review for card:', cardId);
  try {
    // First check if a review exists
    console.log('Supabase: checking if review exists');
    const { data: existingReview, error: fetchError } = await supabase
      .from('reviews')
      .select()
      .eq('card_id', cardId)
      .eq('user_id', userId);

    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;

    const today = getLocalDate();

    if (existingReview.length === 0) {
      // Create new review with default values
      console.log('Supabase: creating new review');
      const { data, error } = await supabase
        .from('reviews')
        .insert({
          card_id: cardId,
          user_id: userId,
          scheduled_date: today,
          interval_days: 1,
          ease_factor: 2.5,
          repetitions: 1,
          last_reviewed_at: new Date().toISOString(),// this is wrong
          next_review_date: review.next_review_date || today,
          card_state: 'learning' // Always start in learning state
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    } else {
      // Update existing review
      const currentState = existingReview[0].card_state;
      let newState;
      
      if (review.result === 'correct') {
        if (currentState === 'new') {
          newState = 'learning';
        } else {
          newState = 'review';
        }
      } else {
        newState = 'learning';
      }

      console.log('Supabase: updating review to state:' + newState + ' because of result:' + review.result + ' and current state:' + currentState);

      const { data, error } = await supabase
        .from('reviews')
        .update({
          interval_days: review.interval_days || existingReview[0].interval_days,
          ease_factor: review.ease_factor || existingReview[0].ease_factor,
          repetitions: (existingReview[0].repetitions || 0) + 1,
          last_reviewed_at: review.last_reviewed_at || new Date().toISOString(),
          next_review_date: review.next_review_date,
          card_state: newState
        })
        .eq('card_id', cardId)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
      return data;
    }
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
          front_audio_path,
          back_audio_path
        )
      `)
      .eq('user_id', userId)
      .lte('next_review_date', getLocalDate())
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

// Helper function to download audio for a card
export const downloadCardAudio = async (audioPath) => {
  if (!audioPath) return null;
  
  try {
    const { data, error } = await supabase.storage
      .from('card-audio')
      .download(audioPath);
    
    if (error) {
      console.error('Error downloading audio:', error);
      throw error;
    }

    return URL.createObjectURL(data);
  } catch (err) {
    console.error('Error downloading audio:', err);
    return null;
  }
}; 