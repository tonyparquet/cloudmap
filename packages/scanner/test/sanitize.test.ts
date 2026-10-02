import { describe, expect, it } from 'vitest';
import { sanitizeProject } from '../src/collectors/cicd.ts';
import { sanitizeFunction, sanitizeTaskDefinition } from '../src/collectors/compute.ts';
import { sanitizeSubscription } from '../src/collectors/integration.ts';

/** Section 0.5 : jamais la valeur d'un secret ni d'une variable d'environnement. */
describe('assainissement des données collectées', () => {
  it('Lambda : seuls les noms des variables d’environnement sont conservés', () => {
    const out = sanitizeFunction({
      FunctionName: 'f',
      Environment: { Variables: { TOKEN: 'secret-lambda' } },
    });
    expect(out.Environment).toEqual({ VariableNames: ['TOKEN'] });
    expect(JSON.stringify(out)).not.toContain('secret-lambda');
  });

  it('ECS : variables réduites à leur nom, secrets réduits à leur référence', () => {
    const out = sanitizeTaskDefinition({
      family: 'api',
      containerDefinitions: [
        {
          name: 'api',
          image: 'img',
          command: ['--password', 'secret-commande'],
          environment: [{ name: 'API_KEY', value: 'secret-ecs' }],
          secrets: [{ name: 'DB', valueFrom: 'arn:aws:secretsmanager:eu-west-3:1:secret:db' }],
        },
      ],
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain('secret-ecs');
    expect(text).not.toContain('secret-commande');
    expect(out?.containerDefinitions[0]?.environment).toEqual([{ name: 'API_KEY' }]);
    expect(out?.containerDefinitions[0]?.secrets[0]?.valueFrom).toContain('secret:db');
  });

  it('CodeBuild : buildspec retiré, seules les variables en clair désignant un dépôt sont gardées', () => {
    const out = sanitizeProject({
      name: 'p',
      source: { type: 'GITLAB', location: 'https://gitlab.com/x/y.git', buildspec: 'echo secret-buildspec' },
      environment: {
        type: 'LINUX_CONTAINER',
        image: 'i',
        computeType: 'BUILD_GENERAL1_SMALL',
        environmentVariables: [
          { name: 'IMAGE_REPO_NAME', value: 'demo-api', type: 'PLAINTEXT' },
          { name: 'DB_PASSWORD', value: 'secret-codebuild', type: 'PLAINTEXT' },
          { name: 'TOKEN', value: 'demo/token', type: 'SECRETS_MANAGER' },
        ],
      },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain('secret-buildspec');
    expect(text).not.toContain('secret-codebuild');
    expect(text).toContain('demo-api');
  });

  it('SNS : pas d’adresse e-mail ni de numéro de téléphone', () => {
    expect(sanitizeSubscription({ Protocol: 'email', Endpoint: 'personne@exemple.fr' })).toEqual({
      Protocol: 'email',
    });
    expect(sanitizeSubscription({ Protocol: 'sms', Endpoint: '+33600000000' })).toEqual({ Protocol: 'sms' });
    expect(
      sanitizeSubscription({ Protocol: 'https', Endpoint: 'https://hook.exemple.fr/x?token=abc' }),
    ).toEqual({
      Protocol: 'https',
      Endpoint: 'https://hook.exemple.fr',
    });
    expect(sanitizeSubscription({ Protocol: 'sqs', Endpoint: 'arn:aws:sqs:eu-west-3:1:q' }).Endpoint).toBe(
      'arn:aws:sqs:eu-west-3:1:q',
    );
  });
});
