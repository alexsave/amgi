const { extractBySpec, stableStringify } = require('./openai-cache');

const fixture = {
    status: 'ok',
    output: [
        {
            type: 'function_call',
            name: 'emit_group_disambiguation',
            id: 'call-001',
            unused_field: { should: 'ignore me' },
            arguments: JSON.stringify({
                core_pick: 'placeholder',
                final_picks: ['placeholder'],
                extra_flag: true,
                assignments: [
                    {
                        korean: '단어A',
                        core_pick: 'lexeme-a',
                        final_picks: ['lexeme-a', 'term-a'],
                        unused_note: 'drop me'
                    },
                    {
                        korean: '단어B',
                        core_pick: 'lexeme-b',
                        final_picks: ['lexeme-b'],
                        unused_note: 'drop me too'
                    }
                ]
            })
        },
        {
            type: 'text',
            content: 'should not appear'
        }
    ],
    metadata: {
        request_id: 'test-123',
        unused: true
    }
};

const expectedKoreanOnly = {
    output: [
        {
            arguments: {
                assignments: [
                    { korean: '단어A' },
                    { korean: '단어B' }
                ]
            }
        }
    ]
};

const expectedCoreAndKorean = {
    output: [
        {
            arguments: {
                assignments: [
                    { korean: '단어A', core_pick: 'lexeme-a' },
                    { korean: '단어B', core_pick: 'lexeme-b' }
                ]
            }
        }
    ]
};

const expectedFullSubset = {
    output: [
        {
            arguments: {
                assignments: [
                    {
                        korean: '단어A',
                        core_pick: 'lexeme-a',
                        final_picks: ['lexeme-a', 'term-a']
                    },
                    {
                        korean: '단어B',
                        core_pick: 'lexeme-b',
                        final_picks: ['lexeme-b']
                    }
                ]
            }
        }
    ]
};

const expectedMixed = {
    output: [
        {
            type: 'function_call',
            arguments: {
                assignments: [
                    { final_picks: ['lexeme-a', 'term-a'] },
                    { core_pick: 'lexeme-b' }
                ]
            }
        }
    ]
};

const scenarios = [
    {
        label: 'korean only',
        selectors: ['output[0].arguments.assignments[*].korean'],
        expected: expectedKoreanOnly
    },
    {
        label: 'core_pick + korean',
        selectors: [
            'output[0].arguments.assignments[*].korean',
            'output[0].arguments.assignments[*].core_pick'
        ],
        expected: expectedCoreAndKorean
    },
    {
        label: 'full assignment subset',
        selectors: [
            'output[0].arguments.assignments[*].korean',
            'output[0].arguments.assignments[*].core_pick',
            'output[0].arguments.assignments[*].final_picks'
        ],
        expected: expectedFullSubset
    },
    {
        label: 'mixed index and wildcard',
        selectors: [
            'output[0].type',
            'output[0].arguments.assignments[1].core_pick',
            'output[0].arguments.assignments[*].final_picks'
        ],
        expected: expectedMixed
    }
];

const assertDeepEqual = (actual, expected, label) => {
    const actualStr = stableStringify(actual);
    const expectedStr = stableStringify(expected);
    if (actualStr !== expectedStr) {
        throw new Error(`Selector test failed for ${label}\nExpected: ${expectedStr}\nActual:   ${actualStr}`);
    }
};

console.log('Selector extraction smoke-test');
for (const { label, selectors, expected } of scenarios) {
    const extracted = extractBySpec(fixture, selectors);
    assertDeepEqual(extracted, expected, label);
    console.log(`✅ ${label}`);
}
