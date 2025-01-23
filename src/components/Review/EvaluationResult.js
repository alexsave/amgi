import React from 'react';

const EvaluationResult = ({ result }) => {
  if (!result) return null;

  return (
    <div className={`evaluation-result ${result.result}`}>
      <div className="result-icon">
        {result.result === 'correct' && '✅'}
        {result.result === 'incorrect' && '❌'}
        {result.result === 'quit' && '⏭️'}
      </div>
      <p>{result.message}</p>
    </div>
  );
};

export default EvaluationResult; 