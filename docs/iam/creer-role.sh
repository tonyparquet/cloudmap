#!/bin/sh
# Création du rôle en lecture seule dans le compte CLIENT (à exécuter par le client).
# Remplacez <ACCOUNT_ID_OUTIL> (compte qui héberge Cartographe AWS) et <EXTERNAL_ID>
# (affiché dans la page « Aide » pour chaque profil) dans trust-policy.json.
set -eu

aws iam create-role \
  --role-name CartographeAwsLectureSeule \
  --description "Lecture seule pour Cartographe AWS" \
  --max-session-duration 3600 \
  --assume-role-policy-document file://trust-policy.json

aws iam put-role-policy \
  --role-name CartographeAwsLectureSeule \
  --policy-name CartographeLecture \
  --policy-document file://readonly-policy.json

# Variante : la politique gérée par AWS « ReadOnlyAccess » fonctionne aussi
# (conserver alors l'instruction Deny de readonly-policy.json pour exclure la lecture des secrets).
# aws iam attach-role-policy --role-name CartographeAwsLectureSeule \
#   --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess

aws iam get-role --role-name CartographeAwsLectureSeule --query Role.Arn --output text
