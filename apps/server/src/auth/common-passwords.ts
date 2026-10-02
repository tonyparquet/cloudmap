/**
 * Liste locale de mots de passe et de bases de mots de passe courants (aucun appel réseau).
 * Un mot de passe est refusé s'il est dans la liste ou si sa base alphabétique (sans chiffres ni
 * symboles) y figure, ex. « Motdepasse2024!! ».
 */
export const COMMON_PASSWORDS = new Set(
  `
password passw0rd motdepasse azerty azertyuiop qwerty qwertyuiop qwertz 123456 1234567 12345678 123456789
1234567890 12345678910 111111 000000 abc123 abcdef abcdefgh iloveyou jetaime soleil bonjour bonsoir loulou
doudou chouchou marseille paris france nicolas camille julien thomas alexandre administrateur administrator
admin root toor letmein welcome bienvenue monkey dragon master shadow sunshine princess football baseball
superman batman starwars trustno1 secret secrets changeme changezmoi default motdepassse password1
passwordpassword motdepassemotdepasse azertyazerty qwertyqwerty aaaaaaaaaaaaaa abcdefghijklmn
correcthorsebatterystaple cartographe cartographeaws amazon amazonwebservices aws awsaws cloud cloudcloud
infrastructure diagramme securite security production prod staging developpement development test testtest
utilisateur user username login connexion ordinateur computer internet network reseau serveur server
entreprise company societe client clients janvier fevrier mars avril mai juin juillet aout septembre
octobre novembre decembre lundi mardi mercredi jeudi vendredi samedi dimanche printemps ete automne hiver
summer winter spring autumn hello hellohello whatever qazwsx qazwsxedc zaqxswcde asdfgh asdfghjkl zxcvbn
zxcvbnm poiuytreza mlkjhgfdsq wxcvbn nbvcxw ilovefrance vivelafrance allezlesbleus olympique psg om
pokemon minecraft fortnite zelda mario naruto onepiece harrypotter matrix michael jennifer jordan
liverpool chelsea arsenal barcelona realmadrid juventus manchester tigger charlie freedom whatever
mustang ferrari porsche mercedes peugeot renault citroen
`
    .split(/\s+/)
    .filter(Boolean),
);

/** Suites triviales : clavier, alphabet, chiffres. */
export const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  'azertyuiopqsdfghjklmwxcvbn',
  'qwertyuiopasdfghjklzxcvbnm',
  '01234567890',
];
