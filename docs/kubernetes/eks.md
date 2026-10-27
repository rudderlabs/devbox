# devbox on Amazon EKS

Status: verified end to end on Kubernetes 1.34 with VPC CNI 1.22, on
`m7g.xlarge` (arm64) nodes.

This page assumes an existing EKS cluster (Kubernetes 1.27 or newer) with EC2
Linux nodes, and the AWS CLI. Each sandbox requests 2 CPU and 8Gi by default
(`sandbox.cpu`, `sandbox.memory`), so use nodes with at least 4 vCPU and 16 GiB,
for example `m7g.xlarge` or `m7i.xlarge`. The page covers the
[prerequisites](README.md#prerequisites); then install as in
[README.md](README.md). Commands change between versions: where this
page and the AWS docs differ, follow the AWS docs.

## Pick how pods get AWS permissions

Only the EBS CSI driver below needs AWS permissions; devbox itself needs none.
Either way works, and each has its own cluster prerequisite.

**EKS Pod Identity** needs the `eks-pod-identity-agent` add-on:

```bash
aws eks create-addon --cluster-name <cluster> --addon-name eks-pod-identity-agent
```

**IRSA** needs an IAM OIDC provider, and so does any other IRSA role you add
later. A cluster created with `eksctl create cluster --with-oidc` already has
one. For an existing cluster:

```bash
eksctl utils associate-iam-oidc-provider --cluster <cluster> --region <region> --approve
# check it:
aws eks describe-cluster --name <cluster> --query 'cluster.identity.oidc.issuer' --output text
```

## Storage: the EBS CSI driver

Install the Amazon EBS CSI driver add-on. Its controller needs an IAM role with
the AWS managed policy `AmazonEBSCSIDriverPolicyV2`, given to the service
account `ebs-csi-controller-sa` in `kube-system` through EKS Pod Identity or
IRSA. See
[Use Kubernetes volume storage with Amazon EBS](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html).

With Pod Identity (the `eks-pod-identity-agent` add-on installed), the role must
trust the service principal `pods.eks.amazonaws.com` for `sts:AssumeRole` and
`sts:TagSession`. `eksctl` can create the role and the association in one step:

```bash
eksctl create podidentityassociation --cluster <cluster> --namespace kube-system \
  --service-account-name ebs-csi-controller-sa \
  --permission-policy-arns arn:aws:iam::aws:policy/AmazonEBSCSIDriverPolicyV2
aws eks create-addon --cluster-name <cluster> --addon-name aws-ebs-csi-driver
```

With a role you created yourself, use
`aws eks create-pod-identity-association --cluster-name <cluster> --namespace kube-system --service-account ebs-csi-controller-sa --role-arn <role-arn>`
instead of the `eksctl` command.

With IRSA, create the role first, then pass it to the add-on.

`--role-only` tells `eksctl` to create the IAM role and stop there, without
creating or annotating the Kubernetes service account. That matters because the
add-on owns `ebs-csi-controller-sa`: EKS creates it and sets its
`eks.amazonaws.com/role-arn` annotation from the `--service-account-role-arn`
below. Letting `eksctl` annotate it too gives the same object two owners, and
the add-on will reconcile it back to its own view.

```bash
eksctl create iamserviceaccount \
  --cluster <cluster> --region <region> \
  --namespace kube-system --name ebs-csi-controller-sa \
  --role-name <cluster>-ebs-csi-irsa \
  --attach-policy-arn arn:aws:iam::aws:policy/AmazonEBSCSIDriverPolicyV2 \
  --role-only --approve

aws eks create-addon --cluster-name <cluster> --addon-name aws-ebs-csi-driver \
  --service-account-role-arn arn:aws:iam::<account>:role/<cluster>-ebs-csi-irsa
```

Then a gp3 StorageClass:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
  encrypted: "true"
```

`WaitForFirstConsumer` is right for EBS: a volume is created in the zone of the pod that first mounts it.

EKS Auto Mode has its own EBS driver, `ebs.csi.eks.amazonaws.com`. Use that
name as the provisioner and as the snapshot class's driver below, and check the
Auto Mode docs for snapshot support.

## Volume snapshots

Install the CSI snapshot controller add-on, which also installs the snapshot
CRDs
([Enable snapshot functionality for CSI volumes](https://docs.aws.amazon.com/eks/latest/userguide/csi-snapshot-controller.html)):

```bash
aws eks create-addon --cluster-name <cluster> --addon-name snapshot-controller
```

Then a VolumeSnapshotClass for the EBS driver:

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-snapclass
driver: ebs.csi.aws.com
deletionPolicy: Delete
```

## NetworkPolicy

The Amazon VPC CNI enforces NetworkPolicy once it is turned on in the add-on's
configuration
([Limit pod traffic with Kubernetes network policies](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html)).
It needs VPC CNI 1.21 or newer and nodes with Linux kernel 5.10 or newer, which
current EKS-optimized Amazon Linux 2023 and Bottlerocket AMIs have. Check the
VPC CNI version:

```bash
kubectl describe daemonset aws-node -n kube-system | grep amazon-k8s-cni: | cut -d : -f 3
```

Then turn on network policy. **`update-addon` replaces the add-on's
configuration, it does not merge it**, so pass back anything the add-on already
has or it is cleared. On a cluster where the VPC CNI uses IRSA -- which is the
case for `eksctl create cluster --with-oidc` -- that includes its service
account role:

```bash
ROLE=$(aws eks describe-addon --cluster-name <cluster> --addon-name vpc-cni \
  --query 'addon.serviceAccountRoleArn' --output text)

aws eks update-addon --cluster-name <cluster> --addon-name vpc-cni \
  --configuration-values '{"enableNetworkPolicy": "true"}' \
  ${ROLE:+--service-account-role-arn "$ROLE"}
```

Omitting `--service-account-role-arn` when the add-on has one sets it to `null`,
which breaks the CNI -- see below.

Then check that enforcement is really on. Check the flag, not the container
count: each `aws-node` pod runs two containers (`2/2`) either way, because the
network policy agent is present even when it enforces nothing.

```bash
kubectl get ds aws-node -n kube-system -o jsonpath='{..args}' \
  | tr ' ' '\n' | grep network-policy
# must print --enable-network-policy=true
```

Wait for the rollout, and check the pods are healthy, not only up to date:

```bash
kubectl rollout status ds/aws-node -n kube-system
kubectl get pods -n kube-system -l k8s-app=aws-node
```

**If `aws-node` crash-loops after this change**, the add-on lost its service
account role, so EKS removed the `eks.amazonaws.com/role-arn` annotation it
manages on the `aws-node` service account. Check it, and put the role back on
the add-on rather than on the service account:

```bash
aws eks describe-addon --cluster-name <cluster> --addon-name vpc-cni \
  --query 'addon.serviceAccountRoleArn' --output text      # null means this happened

aws eks update-addon --cluster-name <cluster> --addon-name vpc-cni \
  --service-account-role-arn <the IRSA role> \
  --configuration-values '{"enableNetworkPolicy": "true"}'
kubectl delete pod -n kube-system -l k8s-app=aws-node
```

Calico or Cilium also work. The installer's first run checks enforcement with
test pods, so a failed `--enable-network-policy` is caught at install time as
well.

## Inbound: webhooks need an Ingress

The chart creates no public address. GitHub and Linear webhooks, and
`@<bot>` comment triggers, need `/webhook/` reachable from the internet -- see
[customizing.md](customizing.md#ingress) and the
[AWS Load Balancer Controller example](customizing.md#example-aws-load-balancer-controller-alb).

EKS ships no ingress controller, so install one first; an Ingress with no
controller stays pending and provisions nothing. Without it the install works
and tasks run, but every inbound feature is silently inactive.

```bash
kubectl get ingressclass    # empty means no controller is installed
```

## Values

Write the [target file](README.md#1-configure), `devbox.k8s.json`. Take the
context from kubectl rather than typing it: `aws eks update-kubeconfig` writes
the cluster ARN, `eksctl` writes `<user>@<cluster>.<region>.eksctl.io`.

```bash
kubectl config get-contexts     # check the cluster you want is the current one

cat > devbox.k8s.json <<EOF
{
  "context": "$(kubectl config current-context)",
  "values": {
    "storage": { "storageClass": "gp3", "volumeSnapshotClass": "ebs-snapclass" }
  }
}
EOF
```

Then:

```bash
bun run k8s:install --target devbox.k8s.json
```

## Notes

- **Restored EBS volumes load lazily.** A volume restored from a snapshot
  fetches each block from S3 on first read, so the first `git status` or build
  in a new task can be slow. Fast snapshot restore, or a provisioned
  initialization rate, removes the delay at a cost; see
  [Initialize Amazon EBS volumes](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-initialize.html).
- **Encryption at rest.** EKS encrypts Kubernetes API data, Secrets included,
  with KMS envelope encryption on Kubernetes 1.28 and newer. To use your own
  KMS key, see
  [Encrypt Kubernetes secrets with KMS](https://docs.aws.amazon.com/eks/latest/userguide/envelope-encryption.html).
  `encrypted: "true"` in the StorageClass encrypts the volumes.
- The chart uses only standard Kubernetes resources; it needs no AWS
  permissions of its own.
