import { answer, bodyOf } from '../../../anki/answer';
import { readSettings } from '../../../../server/anki/settings';
import { resolveTransport } from '../../../../server/anki/transport';
import { notReadyResponse } from '../../../../server/anki/respond';
import { admissionRefusal, limitResponse } from '../../../../server/anki/rateLimit';
import { generateCardTextAndAudio } from '../../../../server/anki/cardText';

// Generates both sides of a card and its audio in one request - never two,
// see cardText.js's own module comment for why splitting them would throw
// away the reading that steers Japanese/Chinese pronunciation.
export async function POST(request) {
  const settings = readSettings(request);
  const result = await resolveTransport(settings);
  if (!result.ops) return notReadyResponse(result.mode);

  const body = bodyOf(request);
  const userInput = (body?.userInput || '').trim();
  const knownLanguage = body?.knownLanguage;
  const learningLanguage = body?.learningLanguage;
  const includeCueAudio = body?.includeCueAudio === true;
  if (!userInput || !knownLanguage || !learningLanguage) {
    return answer(
      { error: 'userInput, knownLanguage and learningLanguage are required' },
      { status: 400 },
    );
  }

  // Not begun at all while the rate gate says Gemini is blocked: the card
  // would only be refused, after spending its text call.
  const refused = admissionRefusal();
  if (refused) return refused;

  try {
    const card = await generateCardTextAndAudio({
      userInput,
      knownLanguage,
      learningLanguage,
      includeCueAudio,
      ops: result.ops,
    });
    return answer({ mode: result.mode, ...card });
  } catch (error) {
    return limitResponse(error) || answer({ error: error.message }, { status: 500 });
  }
}
