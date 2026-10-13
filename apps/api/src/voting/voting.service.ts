import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { Prisma } from '../generated/prisma/client.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { hashCredential, newOpaqueCredential } from '../auth/credentials.js'
import { MODERATOR_ACTOR } from '../auth/auth.service.js'
import { RealtimeGateway } from '../realtime/realtime.gateway.js'
import type { AssemblyStatus, RoundStatus } from '../generated/prisma/enums.js'
import type { CommitteeApprovalDto, CommitteeConfigurationUpdateDto, CreateRoundDto, OfficialResultDto } from './dtos.js'

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'

@Injectable()
export class VotingService {
  constructor(private readonly prisma: PrismaService, private readonly realtime: RealtimeGateway) {}

  async createAssembly(name: string) {
    const joinCode = newOpaqueCredential()
    const joinCodeHash = hashCredential(joinCode)
    await this.prisma.organization.upsert({
      where: { id: ORGANIZATION_ID },
      create: { id: ORGANIZATION_ID, name: 'Unión Hondureña ASDMR', type: 'union' },
      update: {},
    })
    const assembly = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${ORGANIZATION_ID}::uuid FOR UPDATE`
      const liveAssembly = await tx.assembly.findFirst({
        where: { organizationId: ORGANIZATION_ID, status: { in: ['lobby_open', 'lobby_closed', 'in_progress'] } },
        select: { id: true },
      })
      if (liveAssembly) throw new ConflictException('Ya existe una Asamblea activa')
      const created = await tx.assembly.create({
        data: { organizationId: ORGANIZATION_ID, name: name.trim(), status: 'lobby_open', joinCodeHash },
        select: { id: true, name: true, status: true },
      })
      await tx.auditEvent.create({
        data: { assemblyId: created.id, actorRef: MODERATOR_ACTOR, action: 'assembly.created_and_lobby_opened' },
      })
      return created
    })
    this.realtime.assemblyState(assembly.id, { status: assembly.status })
    this.realtime.lobbyState(assembly.id, { status: 'open', participantCount: 0 })
    const url = new URL(process.env.PUBLIC_APP_URL!)
    url.searchParams.set('join', joinCode)
    return { assemblyId: assembly.id, name: assembly.name, status: assembly.status, joinCode, joinUrl: url.toString() }
  }

  async joinAssembly(assemblyCode: string, firstName: string, lastName: string) {
    const participantSessionToken = newOpaqueCredential()
    const assemblyCodeHash = hashCredential(assemblyCode)
    const tokenHash = hashCredential(participantSessionToken)
    const joined = await this.prisma.$transaction(async (tx) => {
      const assemblies = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM assemblies WHERE join_code_hash = ${assemblyCodeHash} FOR UPDATE
      `
      const assembly = assemblies[0]
      if (!assembly) throw new NotFoundException('Asamblea no encontrada')
      if (assembly.status !== 'lobby_open') throw new ConflictException('El ingreso a la sala está cerrado')
      const participant = await tx.participantSession.create({
        data: {
          assemblyId: assembly.id,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          tokenHash,
        },
        select: { id: true, assemblyId: true, firstName: true, lastName: true },
      })
      const count = await tx.participantSession.count({ where: { assemblyId: assembly.id, status: 'active' } })
      return { participant, count }
    })
    this.realtime.participantJoined(joined.participant.assemblyId, {
      participantId: joined.participant.id,
      firstName: joined.participant.firstName,
      lastName: joined.participant.lastName,
    })
    this.realtime.lobbyState(joined.participant.assemblyId, { status: 'open', participantCount: joined.count })
    const state = await this.participantState(joined.participant.id)
    this.realtime.participantState(joined.participant.id, state)
    return {
      participantSessionToken,
      participant: { firstName: joined.participant.firstName, lastName: joined.participant.lastName },
      ...state,
    }
  }

  async participantState(participantId: string) {
    const participant = await this.prisma.participantSession.findUnique({
      where: { id: participantId },
      include: { assembly: { select: { id: true, name: true, status: true, completedAt: true } } },
    })
    if (!participant || participant.status !== 'active') throw new NotFoundException('Sesión no encontrada')
    const round = await this.prisma.round.findFirst({
      where: { assemblyId: participant.assemblyId, OR: [
        { status: { in: ['open', 'closed', 'published'] } },
        { category: 'committee', committeeStage: { in: ['proposals', 'support'] } },
      ] },
      orderBy: { createdAt: 'desc' },
      include: { options: { orderBy: { order: 'asc' }, select: { id: true, label: true } } },
    })
    const participation = round
      ? await this.prisma.participation.findUnique({
          where: { roundId_participantSessionId: { roundId: round.id, participantSessionId: participant.id } },
          select: { id: true },
        })
      : null
    const openRound = round
      ? { roundId: round.id, status: round.status, title: round.title, format: round.format, category: round.category, committeeType: round.committeeType, memberCount: round.memberCount, decisionNote: round.decisionNote, committeeStage: round.committeeStage, committeeConfiguration: round.committeeConfiguration, options: round.options.map((o) => ({ optionId: o.id, label: o.label })) }
      : null
    const officialRoundId = round?.committeeRootRoundId ?? round?.id
    const rootStatus = round?.committeeRootRoundId
      ? (await this.prisma.round.findUnique({ where: { id: round.committeeRootRoundId }, select: { status: true } }))?.status
      : round?.status
    const publishedResultRoundId = round?.status === 'published' ? round.id : rootStatus === 'published' ? officialRoundId : undefined
    const results = publishedResultRoundId ? await this.publishedResults(publishedResultRoundId) : undefined
    const officialResult = publishedResultRoundId ? await this.publishedOfficialResult(officialRoundId!) : null
    const proposals = round?.committeeStage && ['proposals', 'support'].includes(round.committeeStage)
      ? await this.prisma.participantSession.findMany({
          where: { assemblyId: participant.assemblyId, status: 'active', committeeEligible: true, assemblyRole: 'delegate' },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], select: { id: true, firstName: true, lastName: true },
        }) : undefined
    const committeeProposals = round?.committeeStage && ['proposals', 'support'].includes(round.committeeStage)
      ? await this.prisma.committeeProposal.findMany({
          where: { roundId: round.id, status: 'proposed' }, include: { candidate: { select: { firstName: true, lastName: true } }, _count: { select: { supporters: true } } }, orderBy: { createdAt: 'asc' },
        }) : undefined
    const supportedProposalIds = round?.committeeStage === 'support'
      ? new Set((await this.prisma.committeeProposalSupport.findMany({ where: { proposal: { roundId: round.id }, supporterParticipantId: participant.id }, select: { proposalId: true } })).map((support) => support.proposalId))
      : new Set<string>()
    return {
      assembly: { id: participant.assembly.id, name: participant.assembly.name, status: participant.assembly.status, completedAt: participant.assembly.completedAt?.toISOString() ?? null },
      assemblyStatus: participant.assembly.status,
      assemblyCompletedAt: participant.assembly.completedAt?.toISOString() ?? null,
      lobbyStatus: participant.assembly.status === 'lobby_open' ? 'open' as const : 'closed' as const,
      openRound,
      participationStatus: participation ? 'recorded' as const : 'pending' as const,
      ...(results ? { results } : {}),
      ...(officialResult ? { officialResult } : {}),
      ...(proposals ? { committeeCandidates: proposals } : {}),
      ...(committeeProposals ? { committeeProposals: committeeProposals.map((proposal) => ({ id: proposal.id, candidateName: `${proposal.candidate.firstName} ${proposal.candidate.lastName}`, supportCount: proposal._count.supporters, supportedByMe: supportedProposalIds.has(proposal.id) })) } : {}),
    }
  }

  async castVote(participantId: string, roundId: string, selections: string | string[]) {
    const requestedOptionIds = Array.isArray(selections) ? selections : [selections]
    const optionIds = [...new Set(requestedOptionIds)]
    if (requestedOptionIds.length !== optionIds.length) throw new UnprocessableEntityException('No repitas opciones en la papeleta')
    if (!optionIds.length || optionIds.some((id) => !id)) throw new UnprocessableEntityException('Selecciona al menos una opción válida')
    const participant = await this.prisma.participantSession.findUnique({
      where: { id: participantId },
      select: { id: true, assemblyId: true, status: true, assemblyRole: true, committeeEligible: true },
    })
    if (!participant || participant.status !== 'active') throw new ForbiddenException()
    try {
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; assembly_id: string; status: string; format: string; category: string; member_count: number | null; election_seats: number | null }>>`
          SELECT id, assembly_id, status, format, category, member_count, election_seats FROM rounds WHERE id = ${roundId}::uuid FOR UPDATE
        `
        const round = rows[0]
        if (!round) throw new NotFoundException('Ronda no encontrada')
        if (round.assembly_id !== participant.assemblyId) throw new NotFoundException('Ronda no encontrada')
        if (round.status !== 'open') throw new ConflictException('La papeleta no está abierta')
        if (round.category === 'committee' && (participant.assemblyRole !== 'delegate' || !participant.committeeEligible)) {
          throw new ForbiddenException('La elegibilidad para votar esta comisión debe estar confirmada por moderación')
        }
        if (round.format === 'single_choice' && optionIds.length !== 1) throw new UnprocessableEntityException('Esta papeleta permite una sola opción')
        const maxSelections = round.election_seats ?? round.member_count
        if (maxSelections !== null && maxSelections !== undefined && optionIds.length > maxSelections) {
          throw new UnprocessableEntityException(`Puedes seleccionar como máximo ${maxSelections} integrantes`)
        }
        const options = await tx.ballotOption.findMany({ where: { id: { in: optionIds }, roundId }, select: { id: true } })
        if (options.length !== optionIds.length) throw new UnprocessableEntityException('Todas las opciones deben pertenecer a esta papeleta')
        // The unique participation claim and anonymous ballot share a transaction but no shared identity key.
        // If either insert fails, PostgreSQL rolls both back.
        await tx.participation.create({ data: { roundId, participantSessionId: participant.id } })
        await tx.anonymousVote.createMany({ data: optionIds.map((optionId) => ({ roundId, optionId })) })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Ya se registró una participación para esta ronda')
      }
      throw error
    }
    const [state, recorded, eligible] = await Promise.all([
      this.participantState(participantId),
      this.prisma.participation.count({ where: { roundId } }),
      this.prisma.participantSession.count({ where: { assemblyId: participant.assemblyId, status: 'active' } }),
    ])
    this.realtime.participantState(participantId, state)
    this.realtime.participationCount(participant.assemblyId, { roundId, recorded, eligible })
    return { accepted: true, participationStatus: 'recorded' as const }
  }

  async publicState(assemblyCode: string) {
    const assembly = await this.prisma.assembly.findUnique({
      where: { joinCodeHash: hashCredential(assemblyCode) },
      include: {
        rounds: { where: { status: { in: ['open', 'closed', 'published'] } }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
    if (!assembly) throw new NotFoundException('Asamblea no encontrada')
    let round = assembly.rounds[0]
    const [participantCount, participants, recordedCount] = await Promise.all([
      this.prisma.participantSession.count({ where: { assemblyId: assembly.id, status: 'active' } }),
      assembly.status === 'lobby_open'
        ? this.prisma.participantSession.findMany({
            where: { assemblyId: assembly.id, status: 'active' },
            orderBy: { joinedAt: 'asc' },
            select: { firstName: true, lastName: true },
          })
        : Promise.resolve(undefined),
      round && ['open', 'closed'].includes(round.status)
        ? this.prisma.participation.count({ where: { roundId: round.id } })
        : Promise.resolve(undefined),
    ])
    if (round?.committeeRootRoundId) {
      const root = await this.prisma.round.findUnique({ where: { id: round.committeeRootRoundId }, include: { options: { orderBy: { order: 'asc' } } } })
      if (root?.status === 'published') round = root
    }
    const officialRoundId = round?.committeeRootRoundId ?? round?.id
    const result = round?.status === 'published' ? await this.publishedResults(round.id) : undefined
    const officialResult = round?.status === 'published' || officialRoundId !== round?.id
      ? await this.publishedOfficialResult(officialRoundId!) : null
    return {
      assembly: { id: assembly.id, name: assembly.name, status: assembly.status, completedAt: assembly.completedAt?.toISOString() ?? null },
      participantCount,
      ...(participants ? { participants } : {}),
      ...(recordedCount !== undefined ? { recordedCount, eligibleCount: participantCount } : {}),
      round: round ? { id: round.id, title: round.title, status: round.status, format: round.format, category: round.category, committeeType: round.committeeType, memberCount: round.memberCount, decisionNote: round.decisionNote, committeeStage: round.committeeStage } : null,
      ...(result ? { results: result } : {}),
      ...(officialResult ? { officialResult } : {}),
    }
  }

  async moderatorAssembly(assemblyId: string) {
    const assembly = await this.prisma.assembly.findUnique({
      where: { id: assemblyId },
      include: {
        participants: { where: { status: 'active' }, orderBy: { joinedAt: 'asc' }, select: { id: true, firstName: true, lastName: true, status: true, joinedAt: true, assemblyRole: true, committeeEligible: true } },
        rounds: { orderBy: { createdAt: 'asc' }, include: { options: { orderBy: { order: 'asc' } }, committeeProposals: { include: { candidate: { select: { firstName: true, lastName: true } }, _count: { select: { supporters: true } } }, orderBy: { createdAt: 'asc' } }, committeeWinners: { include: { candidate: { select: { firstName: true, lastName: true } } }, orderBy: { order: 'asc' } }, _count: { select: { participations: true } } } },
      },
    })
    if (!assembly) throw new NotFoundException('Asamblea no encontrada')
    const rounds = await Promise.all(assembly.rounds.map(async (round) => ({
      id: round.id,
      title: round.title,
      format: round.format,
      category: round.category,
      committeeType: round.committeeType,
      memberCount: round.memberCount,
      decisionNote: round.decisionNote,
      committeeStage: round.committeeStage,
      committeeConfiguration: round.committeeConfiguration,
      electionSeats: round.electionSeats,
      committeeRootRoundId: round.committeeRootRoundId,
      countingRule: round.countingRule,
      status: round.status,
      options: round.options,
      committeeProposals: round.committeeProposals.map((proposal) => ({
        id: proposal.id,
        candidateParticipantId: proposal.candidateParticipantId,
        candidateName: `${proposal.candidate.firstName} ${proposal.candidate.lastName}`,
        status: proposal.status,
        supportCount: proposal._count.supporters,
        approvalYes: proposal.approvalYes,
        approvalNo: proposal.approvalNo,
      })),
      committeeComposition: round.committeeWinners.map((winner) => ({ participantId: winner.candidateParticipantId, name: `${winner.candidate.firstName} ${winner.candidate.lastName}`, order: winner.order })),
      participationCount: round._count.participations,
      ...(round.status === 'published' ? { results: await this.publishedResults(round.id) } : {}),
      officialResult: await this.moderatorOfficialResult(round.id),
    })))
    return {
      id: assembly.id,
      name: assembly.name,
      status: assembly.status,
      completedAt: assembly.completedAt?.toISOString() ?? null,
      participants: assembly.participants,
      participantCount: assembly.participants.length,
      rounds,
    }
  }

  async changeLobby(assemblyId: string, status: 'lobby_open' | 'lobby_closed') {
    if (status === 'lobby_open') throw new ForbiddenException('La reapertura está deshabilitada hasta validación de Secretaría/mesa')
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM assemblies WHERE id = ${assemblyId}::uuid FOR UPDATE
      `
      const assembly = rows[0]
      if (!assembly) throw new NotFoundException('Asamblea no encontrada')
      if (assembly.status === 'completed') throw new ConflictException('La Asamblea ya finalizó; no se permiten cambios operativos')
      if (assembly.status === 'lobby_closed' || assembly.status === 'in_progress') return { id: assembly.id, status: assembly.status, changed: false }
      if (assembly.status !== 'lobby_open') throw new ConflictException('La Asamblea no permite cerrar el ingreso')
      const updated = await tx.assembly.update({ where: { id: assemblyId }, data: { status: 'lobby_closed' }, select: { id: true, status: true } })
      await tx.auditEvent.create({ data: { assemblyId, actorRef: MODERATOR_ACTOR, action: 'lobby.closed' } })
      return { ...updated, changed: true }
    })
    if (!result.changed) return { id: result.id, status: result.status }
    const count = await this.prisma.participantSession.count({ where: { assemblyId, status: 'active' } })
    this.realtime.assemblyState(assemblyId, { status: result.status as AssemblyStatus })
    this.realtime.lobbyState(assemblyId, { status: 'closed', participantCount: count })
    return result
  }

  async completeAssembly(assemblyId: string, confirmation: true) {
    const completed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: AssemblyStatus; completed_at: Date | null; updated_at: Date }>>`
        SELECT id, status, completed_at, updated_at FROM assemblies WHERE id = ${assemblyId}::uuid FOR UPDATE
      `
      const assembly = rows[0]
      if (!assembly) throw new NotFoundException('Asamblea no encontrada')
      if (assembly.status === 'completed') {
        return { id: assembly.id, status: assembly.status, completedAt: assembly.completed_at ?? assembly.updated_at, changed: false }
      }
      if (assembly.status === 'preparing') throw new ConflictException('La Asamblea aún no ha comenzado y no puede finalizarse')
      const openRound = await tx.round.findFirst({ where: { assemblyId, status: 'open' }, select: { id: true } })
      if (openRound) throw new ConflictException('Cierra la papeleta abierta antes de finalizar la Asamblea')
      if (confirmation !== true) throw new UnprocessableEntityException('Confirma explícitamente la finalización de la Asamblea')
      const completedAt = new Date()
      const updated = await tx.assembly.update({
        where: { id: assemblyId },
        data: { status: 'completed', completedAt },
        select: { id: true, status: true, completedAt: true },
      })
      await tx.auditEvent.create({
        data: { assemblyId, actorRef: MODERATOR_ACTOR, action: 'assembly.completed', occurredAt: completedAt },
      })
      return { id: updated.id, status: updated.status, completedAt, changed: true }
    })
    if (completed.changed) {
      this.realtime.assemblyState(assemblyId, { status: 'completed', completedAt: completed.completedAt.toISOString() })
    }
    return { id: completed.id, status: completed.status, completedAt: completed.completedAt.toISOString() }
  }

  async patchParticipant(participantId: string, input: { firstName?: string; lastName?: string; status?: 'removed'; assemblyRole?: 'president' | 'vice_president' | 'secretary' | 'treasurer' | 'delegate' | null; committeeEligible?: boolean }) {
    const identity = await this.prisma.participantSession.findUnique({ where: { id: participantId }, select: { assemblyId: true } })
    if (!identity) throw new NotFoundException('Participante no encontrado')
    if (input.firstName === undefined && input.lastName === undefined && input.status === undefined && input.assemblyRole === undefined && input.committeeEligible === undefined) {
      throw new UnprocessableEntityException('Indica un cambio para el participante')
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM assemblies WHERE id = ${identity.assemblyId}::uuid FOR UPDATE`
      const assembly = await tx.assembly.findUnique({ where: { id: identity.assemblyId }, select: { status: true } })
      if (!assembly) throw new NotFoundException('Asamblea no encontrada')
      if (assembly.status === 'completed') throw new ConflictException('La Asamblea ya finalizó; no se permiten cambios operativos')
      const hasVoted = await tx.participation.count({ where: { participantSessionId: participantId } }) > 0
      const hasStartedCommittee = await tx.round.count({ where: { assemblyId: identity.assemblyId, category: 'committee', committeeStage: { in: ['proposals', 'support', 'approval', 'election', 'tie_break_required', 'tie_break', 'composition_ready'] } } }) > 0
      const changesRoster = input.firstName !== undefined || input.lastName !== undefined || input.status !== undefined
      const changesEligibility = input.assemblyRole !== undefined || input.committeeEligible !== undefined
      if ((changesRoster && (assembly.status === 'in_progress' || hasVoted)) || (changesEligibility && hasStartedCommittee)) {
        throw new ConflictException('La lista o elegibilidad ya no admite cambios después de iniciar la votación aplicable')
      }
      const current = await tx.participantSession.findUnique({ where: { id: participantId }, select: { id: true } })
      if (!current) throw new NotFoundException('Participante no encontrado')
      const value = await tx.participantSession.update({
        where: { id: participantId },
        data: {
          ...(input.firstName !== undefined ? { firstName: input.firstName.trim() } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName.trim() } : {}),
          ...(input.status === 'removed' ? { status: 'removed' as const } : {}),
          ...(input.assemblyRole !== undefined ? { assemblyRole: input.assemblyRole } : {}),
          ...(input.committeeEligible !== undefined ? { committeeEligible: input.committeeEligible } : {}),
        },
        select: { id: true, assemblyId: true, firstName: true, lastName: true, status: true, assemblyRole: true, committeeEligible: true },
      })
      await tx.auditEvent.create({ data: { assemblyId: identity.assemblyId, actorRef: MODERATOR_ACTOR, action: input.status === 'removed' ? 'participant.removed' : changesEligibility ? 'participant.committee_eligibility_configured' : 'participant.corrected', metadata: { participantId, ...(input.assemblyRole ? { assemblyRole: input.assemblyRole } : {}), ...(input.committeeEligible !== undefined ? { committeeEligible: input.committeeEligible } : {}) } } })
      return value
    })
    if (updated.status === 'removed') {
      this.realtime.participantRemoved(updated.assemblyId, updated.id)
      const count = await this.prisma.participantSession.count({ where: { assemblyId: updated.assemblyId, status: 'active' } })
      const assembly = await this.prisma.assembly.findUniqueOrThrow({ where: { id: updated.assemblyId }, select: { status: true } })
      this.realtime.lobbyState(updated.assemblyId, { status: assembly.status === 'lobby_open' ? 'open' : 'closed', participantCount: count })
    } else this.realtime.participantUpdated(updated.assemblyId, { participantId: updated.id, firstName: updated.firstName, lastName: updated.lastName })
    return { id: updated.id, firstName: updated.firstName, lastName: updated.lastName, status: updated.status, assemblyRole: updated.assemblyRole, committeeEligible: updated.committeeEligible }
  }

  async createRound(assemblyId: string, input: CreateRoundDto) {
    const category = input.category ?? 'office'
    if (category === 'committee' && !input.committeeType) {
      throw new UnprocessableEntityException('Selecciona el tipo de comisión')
    }
    if (category === 'office' && (input.committeeType || input.memberCount !== undefined)) {
      throw new UnprocessableEntityException('Los metadatos de comisión solo aplican a rondas de comisión')
    }
    if (category === 'committee' && input.committeeType === 'nomination' && input.memberCount !== undefined && (input.memberCount < 5 || input.memberCount % 2 === 0)) {
      throw new UnprocessableEntityException('La Comisión de Nombramiento requiere un número impar de al menos cinco integrantes')
    }
    if (category === 'committee' && input.memberCount !== undefined && ['finance', 'statutes'].includes(input.committeeType ?? '') && ![3, 5].includes(input.memberCount)) {
      throw new UnprocessableEntityException('Finanzas y Estatutos admiten tres o cinco integrantes')
    }
    if (!input.countingRule || Array.isArray(input.countingRule) || Object.keys(input.countingRule).length === 0) {
      throw new UnprocessableEntityException('countingRule debe declarar explícitamente la regla configurada')
    }
    if (input.countingRule.kind !== 'count_only') throw new UnprocessableEntityException('La única regla compatible con V1 es kind: count_only; no se determina un ganador')
    const options = input.options ?? []
    if (category === 'office' && options.length < 1) throw new UnprocessableEntityException('Agrega al menos una opción')
    const labels = options.map(({ label }) => label.trim())
    if (labels.some((label) => !label) || new Set(labels.map((label) => label.toLocaleLowerCase())).size !== labels.length) {
      throw new UnprocessableEntityException('Las opciones deben tener etiquetas no vacías y distintas')
    }
    const rules = input.committeeConfiguration ?? {}
    const validated = category === 'committee' && Boolean(
      rules.institutionallyValidated && input.decisionNote?.trim() && rules.validationReference?.trim() && rules.eligibilityRule?.trim() && rules.votingMethod?.trim(),
    )
    const nominationReady = input.committeeType === 'nomination' && Boolean(
      validated && rules.proposalRule === 'eligible_delegate_only' && rules.supportRule === 'one_per_eligible_delegate' &&
      Number.isInteger(Number(rules.supportMinimum)) && Number(rules.supportMinimum) > 0 && rules.approvalDenominator,
    )
    let stage: 'configuration_required' | 'proposals' | 'election' | null = category !== 'committee' ? null
      : input.committeeType === 'nomination'
        ? (nominationReady ? 'proposals' : 'configuration_required')
        : (validated && input.memberCount && options.length ? 'election' : 'configuration_required')
    const round = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM assemblies WHERE id = ${assemblyId}::uuid FOR UPDATE
      `
      const assembly = rows[0]
      if (!assembly) throw new NotFoundException('Asamblea no encontrada')
      if (assembly.status === 'completed') throw new ConflictException('La Asamblea ya finalizó; no se permiten nuevas papeletas')
      if (!['lobby_closed', 'in_progress'].includes(assembly.status)) throw new ConflictException('Cierra el ingreso antes de preparar una papeleta')
      if (input.committeeType === 'nomination' && stage === 'proposals') {
        const roleCounts = await Promise.all((['president', 'vice_president', 'secretary', 'treasurer'] as const).map((assemblyRole) =>
          tx.participantSession.count({ where: { assemblyId, status: 'active', assemblyRole } })))
        const eligibleCount = await tx.participantSession.count({ where: { assemblyId, status: 'active', assemblyRole: 'delegate', committeeEligible: true } })
        if (roleCounts.some((count) => count < 1) || eligibleCount < (input.memberCount ?? 5) || Number(rules.supportMinimum) > eligibleCount) stage = 'configuration_required'
      }
      if (category === 'committee' && input.committeeType !== 'nomination' && validated) {
        const candidateIds = options.map((option) => option.candidateParticipantId)
        if (candidateIds.some((id) => !id) || new Set(candidateIds).size !== candidateIds.length) {
          throw new UnprocessableEntityException('Selecciona participantes distintos marcados como elegibles para esta comisión')
        }
        const eligibleCandidates = await tx.participantSession.count({ where: { assemblyId, id: { in: candidateIds as string[] }, status: 'active', assemblyRole: 'delegate', committeeEligible: true } })
        if (eligibleCandidates !== candidateIds.length) throw new UnprocessableEntityException('Cada integrante debe estar activo y confirmado como elegible por Secretaría o la mesa')
      }
      const created = await tx.round.create({
        data: {
          assemblyId,
          title: input.title.trim(),
          format: category === 'committee' ? 'multiple_choice' : (input.format ?? 'single_choice'),
          category,
          committeeType: category === 'committee' ? input.committeeType : null,
          memberCount: category === 'committee' ? input.memberCount ?? null : null,
          decisionNote: category === 'committee' ? input.decisionNote?.trim() || null : null,
          committeeStage: stage,
          committeeConfiguration: category === 'committee' ? rules as Prisma.InputJsonValue : Prisma.JsonNull,
          electionSeats: category === 'committee' ? input.memberCount ?? null : null,
          countingRule: input.countingRule as Prisma.InputJsonValue,
          options: { create: labels.map((label, order) => ({ label, order, ...(options[order]?.candidateParticipantId ? { candidateParticipantId: options[order].candidateParticipantId } : {}) })) },
        },
        include: { options: { orderBy: { order: 'asc' } } },
      })
      await tx.auditEvent.create({ data: { assemblyId, roundId: created.id, actorRef: MODERATOR_ACTOR, action: 'round.prepared' } })
      return created
    })
    const createdRound = await this.prisma.round.findUniqueOrThrow({ where: { id: round.id }, include: { options: { orderBy: { order: 'asc' } } } })
    return { id: createdRound.id, title: createdRound.title, format: createdRound.format, category: createdRound.category, committeeType: createdRound.committeeType, memberCount: createdRound.memberCount, decisionNote: createdRound.decisionNote, committeeStage: createdRound.committeeStage, committeeConfiguration: createdRound.committeeConfiguration, countingRule: createdRound.countingRule, status: createdRound.status, options: createdRound.options }
  }

  async updateCommitteeConfiguration(roundId: string, input: CommitteeConfigurationUpdateDto) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; assembly_id: string; status: string; committee_type: string | null; committee_stage: string | null; member_count: number | null; decision_note: string | null; committee_configuration: Record<string, unknown> | null }>>`
        SELECT id, assembly_id, status, committee_type, committee_stage, member_count, decision_note, committee_configuration FROM rounds WHERE id = ${roundId}::uuid FOR UPDATE
      `
      const round = rows[0]
      if (!round || round.committee_type === null) throw new NotFoundException('Comisión no encontrada')
      if (round.status !== 'draft' || !['configuration_required', 'proposals', 'support'].includes(round.committee_stage ?? '')) throw new ConflictException('La configuración ya quedó congelada al iniciar la votación')
      const memberCount = input.memberCount ?? round.member_count
      const decisionNote = input.decisionNote?.trim() ?? round.decision_note
      const config = { ...(round.committee_configuration ?? {}), ...(input.committeeConfiguration ?? {}) }
      const validated = Boolean(config.institutionallyValidated && decisionNote && config.validationReference && config.eligibilityRule && config.votingMethod)
      if (round.committee_type === 'nomination' && memberCount !== null && memberCount !== undefined && (memberCount < 5 || memberCount % 2 === 0)) {
        throw new UnprocessableEntityException('Nombramiento requiere un cupo impar de al menos cinco integrantes')
      }
      if (validated && ['finance', 'statutes'].includes(round.committee_type) && ![3, 5].includes(memberCount ?? 0)) {
        throw new UnprocessableEntityException('Finanzas y Estatutos requieren tres o cinco integrantes confirmados')
      }
      let nextStage: 'configuration_required' | 'proposals' | 'support' | 'election' = 'configuration_required'
      if (validated && memberCount) {
        if (round.committee_type === 'nomination') {
          const supportMinimum = Number(config.supportMinimum)
          const ready = Boolean(config.proposalRule === 'eligible_delegate_only' && config.supportRule === 'one_per_eligible_delegate' && Number.isInteger(supportMinimum) && supportMinimum >= 1 && ['eligible_delegates', 'valid_votes'].includes(String(config.approvalDenominator)))
          const roleCounts = await Promise.all((['president', 'vice_president', 'secretary', 'treasurer'] as const).map((assemblyRole) =>
            tx.participantSession.count({ where: { assemblyId: round.assembly_id, status: 'active', assemblyRole } })))
          const eligibleCount = await tx.participantSession.count({ where: { assemblyId: round.assembly_id, status: 'active', assemblyRole: 'delegate', committeeEligible: true } })
          if (ready && roleCounts.every((count) => count > 0) && eligibleCount >= memberCount && supportMinimum <= eligibleCount) nextStage = round.committee_stage === 'support' ? 'support' : 'proposals'
        } else if (round.committee_type === 'finance' || round.committee_type === 'statutes') {
          const eligibleOptions = await tx.ballotOption.count({ where: { roundId, candidateParticipantId: { not: null }, candidateParticipant: { is: { status: 'active', assemblyRole: 'delegate', committeeEligible: true } } } })
          const optionCount = await tx.ballotOption.count({ where: { roundId } })
          if ([3, 5].includes(memberCount) && optionCount >= memberCount && eligibleOptions === optionCount) nextStage = 'election'
        } else if (round.committee_type === 'plans' || round.committee_type === 'other') {
          const optionCount = await tx.ballotOption.count({ where: { roundId } })
          const eligibleOptions = await tx.ballotOption.count({ where: { roundId, candidateParticipantId: { not: null }, candidateParticipant: { is: { status: 'active', assemblyRole: 'delegate', committeeEligible: true } } } })
          if (config.eligibilityRule && config.votingMethod && optionCount > 0 && eligibleOptions === optionCount) nextStage = 'election'
        }
      }
      const updated = await tx.round.update({
        where: { id: roundId },
        data: {
          memberCount,
          electionSeats: memberCount,
          decisionNote,
          committeeConfiguration: config as Prisma.InputJsonValue,
          committeeStage: nextStage,
          format: 'multiple_choice',
        },
        select: { id: true, committeeStage: true, memberCount: true, decisionNote: true, committeeConfiguration: true },
      })
      await tx.auditEvent.create({ data: { assemblyId: round.assembly_id, roundId, actorRef: MODERATOR_ACTOR, action: nextStage === 'configuration_required' ? 'committee.configuration.blocked' : 'committee.configuration.validated', metadata: { stage: nextStage, committeeType: round.committee_type, memberCount } } })
      const eligibleCount = round.committee_type === 'nomination'
        ? await tx.participantSession.count({ where: { assemblyId: round.assembly_id, status: 'active', assemblyRole: 'delegate', committeeEligible: true } })
        : null
      const impossibleMinimum = round.committee_type === 'nomination' && Number(config.supportMinimum) > (eligibleCount ?? 0)
      return { ...updated, ready: nextStage !== 'configuration_required', message: impossibleMinimum ? `El mínimo de apoyos (${Number(config.supportMinimum)}) supera los ${eligibleCount} delegados elegibles activos; corrígelo antes de continuar.` : nextStage === 'configuration_required' ? 'Falta completar o validar decisiones institucionales y confirmar la elegibilidad requerida.' : 'Configuración validada; puede continuar el flujo.' }
    })
  }

  async submitCommitteeProposal(participantId: string, roundId: string, candidateParticipantId: string) {
    const proposer = await this.prisma.participantSession.findUnique({ where: { id: participantId }, select: { id: true, assemblyId: true, status: true, assemblyRole: true, committeeEligible: true } })
    if (!proposer || proposer.status !== 'active' || proposer.assemblyRole !== 'delegate' || !proposer.committeeEligible) throw new ForbiddenException('Solo un delegado marcado como elegible puede presentar propuestas')
    const round = await this.prisma.round.findUnique({ where: { id: roundId }, select: { id: true, assemblyId: true, category: true, committeeType: true, committeeStage: true, status: true, committeeConfiguration: true } })
    if (!round || round.assemblyId !== proposer.assemblyId) throw new NotFoundException('Proceso no encontrado')
    if (round.category !== 'committee' || round.committeeType !== 'nomination' || round.committeeStage !== 'proposals' || round.status !== 'draft') throw new ConflictException('El proceso no está recibiendo propuestas')
    if ((round.committeeConfiguration as Record<string, unknown> | null)?.proposalRule !== 'eligible_delegate_only') throw new ConflictException('Secretaría o la mesa debe validar una regla de presentación de propuestas que el sistema pueda aplicar')
    const candidate = await this.prisma.participantSession.findUnique({ where: { id: candidateParticipantId }, select: { id: true, assemblyId: true, status: true, assemblyRole: true, committeeEligible: true } })
    if (!candidate || candidate.assemblyId !== round.assemblyId || candidate.status !== 'active') throw new UnprocessableEntityException('La candidatura debe pertenecer a un delegado activo de esta Asamblea')
    if (!candidate.committeeEligible || candidate.assemblyRole !== 'delegate') throw new UnprocessableEntityException('La persona no está confirmada como elegible o tiene un cargo excluido')
    try {
      const proposal = await this.prisma.committeeProposal.create({ data: { roundId, candidateParticipantId, proposedByParticipantId: participantId }, select: { id: true, roundId: true, candidateParticipantId: true } })
      await this.prisma.auditEvent.create({ data: { assemblyId: round.assemblyId, roundId, actorRef: participantId, action: 'committee.nomination.proposed', metadata: { proposalId: proposal.id, candidateParticipantId } } })
      return proposal
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Esta persona ya fue propuesta')
      throw error
    }
  }

  async supportCommitteeProposal(participantId: string, roundId: string, proposalId: string) {
    const participant = await this.prisma.participantSession.findUnique({ where: { id: participantId }, select: { id: true, assemblyId: true, status: true, assemblyRole: true, committeeEligible: true } })
    if (!participant || participant.status !== 'active' || participant.assemblyRole !== 'delegate' || !participant.committeeEligible) throw new ForbiddenException('Solo un delegado marcado como elegible puede apoyar una propuesta')
    const round = await this.prisma.round.findUnique({ where: { id: roundId }, select: { assemblyId: true, category: true, committeeType: true, committeeStage: true, committeeConfiguration: true } })
    if (!round || round.assemblyId !== participant.assemblyId || round.category !== 'committee' || round.committeeType !== 'nomination' || round.committeeStage !== 'support') throw new ConflictException('El proceso no está recibiendo apoyos')
    if ((round.committeeConfiguration as Record<string, unknown> | null)?.supportRule !== 'one_per_eligible_delegate') throw new ConflictException('Secretaría o la mesa debe validar una regla de apoyo que el sistema pueda aplicar')
    const proposal = await this.prisma.committeeProposal.findFirst({ where: { id: proposalId, roundId, status: 'proposed' }, select: { id: true } })
    if (!proposal) throw new NotFoundException('Propuesta no disponible')
    try {
      await this.prisma.committeeProposalSupport.create({ data: { proposalId, supporterParticipantId: participantId } })
      await this.prisma.auditEvent.create({ data: { assemblyId: round.assemblyId, roundId, actorRef: participantId, action: 'committee.nomination.supported', metadata: { proposalId } } })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Ya registraste tu apoyo a esta propuesta')
      throw error
    }
    return { supported: true }
  }

  async advanceCommitteeStage(roundId: string, stage: 'support' | 'approval' | 'election') {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; assembly_id: string; status: string; committee_stage: string | null; committee_type: string | null; member_count: number | null; committee_configuration: Record<string, unknown> | null }>>`
        SELECT id, assembly_id, status, committee_stage, committee_type, member_count, committee_configuration FROM rounds WHERE id = ${roundId}::uuid FOR UPDATE
      `
      const round = rows[0]
      if (!round || round.committee_type !== 'nomination' || round.status !== 'draft') throw new ConflictException('El proceso de Nombramiento no se puede avanzar desde su estado actual')
      const config = round.committee_configuration ?? {}
      if (stage === 'support' && round.committee_stage === 'proposals') {
        const proposalCount = await tx.committeeProposal.count({ where: { roundId, status: 'proposed' } })
        if (!proposalCount) throw new ConflictException('Registra al menos una propuesta antes de iniciar apoyos')
        await tx.round.update({ where: { id: roundId }, data: { committeeStage: 'support' } })
      } else if (stage === 'approval' && round.committee_stage === 'support') {
        const eligibleCount = await tx.participantSession.count({ where: { assemblyId: round.assembly_id, status: 'active', assemblyRole: 'delegate', committeeEligible: true } })
        const minimum = Number(config.supportMinimum)
        if (!Number.isInteger(minimum) || minimum < 1) throw new ConflictException('Falta validar el mínimo de apoyos institucional')
        if (minimum > eligibleCount) throw new ConflictException(`No se pueden cerrar los apoyos: el mínimo configurado (${minimum}) supera los ${eligibleCount} delegados elegibles activos. Corrige la configuración o valida el padrón.`)
        const proposals = await tx.committeeProposal.findMany({ where: { roundId, status: 'proposed' }, include: { _count: { select: { supporters: true } } } })
        for (const proposal of proposals) {
          await tx.committeeProposal.update({ where: { id: proposal.id }, data: { status: proposal._count.supporters >= minimum ? 'supported' : 'rejected' } })
        }
        if (!proposals.some((proposal) => proposal._count.supporters >= minimum)) throw new ConflictException('Ninguna propuesta alcanzó el mínimo de apoyos configurado')
        await tx.round.update({ where: { id: roundId }, data: { committeeStage: 'approval' } })
      } else if (stage === 'election' && round.committee_stage === 'approval') {
        const pending = await tx.committeeProposal.count({ where: { roundId, status: 'supported' } })
        if (pending) throw new ConflictException('Registra la aprobación por mayoría simple de cada propuesta apoyada')
        const approved = await tx.committeeProposal.findMany({ where: { roundId, status: 'approved' }, orderBy: { createdAt: 'asc' }, include: { candidate: { select: { id: true, firstName: true, lastName: true } } } })
        if (approved.length < (round.member_count ?? 5)) throw new ConflictException('Faltan candidaturas aprobadas para cubrir los cupos')
        await tx.ballotOption.createMany({ data: approved.map((proposal, order) => ({ roundId, label: `${proposal.candidate.firstName} ${proposal.candidate.lastName}`, order, candidateParticipantId: proposal.candidate.id })) })
        await tx.round.update({ where: { id: roundId }, data: { committeeStage: 'election', format: 'multiple_choice', electionSeats: round.member_count } })
      } else throw new ConflictException('Transición de comisión no permitida')
      await tx.auditEvent.create({ data: { assemblyId: round.assembly_id, roundId, actorRef: MODERATOR_ACTOR, action: `committee.stage.${stage}`, metadata: { previousStage: round.committee_stage } } })
      return { roundId, stage }
    })
  }

  async recordCommitteeApproval(roundId: string, proposalId: string, input: CommitteeApprovalDto) {
    return this.prisma.$transaction(async (tx) => {
      const round = await tx.round.findUnique({ where: { id: roundId }, select: { assemblyId: true, category: true, committeeType: true, committeeStage: true, committeeConfiguration: true } })
      if (!round || round.category !== 'committee' || round.committeeType !== 'nomination' || round.committeeStage !== 'approval') throw new ConflictException('El proceso no está en aprobación de candidaturas')
      const proposal = await tx.committeeProposal.findFirst({ where: { id: proposalId, roundId, status: 'supported' }, select: { id: true } })
      if (!proposal) throw new NotFoundException('Propuesta apoyada no disponible')
      const config = (round.committeeConfiguration ?? {}) as Record<string, unknown>
      const basis = config.approvalDenominator
      const eligibleCount = await tx.participantSession.count({ where: { assemblyId: round.assemblyId, status: 'active', assemblyRole: 'delegate', committeeEligible: true } })
      const denominator = basis === 'eligible_delegates' ? eligibleCount : input.yesVotes + input.noVotes
      if (!['eligible_delegates', 'valid_votes'].includes(String(basis))) throw new ConflictException('Falta validar la base de mayoría simple con Secretaría o la mesa')
      if (input.yesVotes + input.noVotes > eligibleCount) throw new UnprocessableEntityException('Los votos registrados superan el número de delegados elegibles confirmados')
      const approved = denominator > 0 && input.yesVotes * 2 > denominator
      const decided = await tx.committeeProposal.update({ where: { id: proposalId }, data: { status: approved ? 'approved' : 'rejected', approvalYes: input.yesVotes, approvalNo: input.noVotes, decidedAt: new Date() } })
      await tx.auditEvent.create({ data: { assemblyId: round.assemblyId, roundId, actorRef: MODERATOR_ACTOR, action: 'committee.nomination.approval_recorded', metadata: { proposalId, yesVotes: input.yesVotes, noVotes: input.noVotes, denominator, basis: String(basis), approved } } })
      return { proposalId: decided.id, status: decided.status, yesVotes: decided.approvalYes, noVotes: decided.approvalNo, denominator }
    })
  }

  async openRound(roundId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const rounds = await tx.$queryRaw<Array<{ id: string; assembly_id: string; status: string; category: string; committee_stage: string | null }>>`
        SELECT id, assembly_id, status, category, committee_stage FROM rounds WHERE id = ${roundId}::uuid FOR UPDATE
      `
      const round = rounds[0]
      if (!round) throw new NotFoundException('Ronda no encontrada')
      if (round.status === 'open') return { roundId: round.id, assemblyId: round.assembly_id, status: 'open' as const, changed: false }
      if (round.status !== 'draft') throw new ConflictException('La ronda no se puede abrir desde su estado actual')
      if (round.category === 'committee' && !['election', 'tie_break'].includes(round.committee_stage ?? '')) {
        throw new ConflictException('La comisión no está lista para votar: completa y valida primero su configuración y etapas anteriores')
      }
      await tx.$queryRaw`SELECT id FROM assemblies WHERE id = ${round.assembly_id}::uuid FOR UPDATE`
      const assembly = await tx.assembly.findUnique({ where: { id: round.assembly_id }, select: { status: true } })
      if (assembly?.status === 'completed') throw new ConflictException('La Asamblea ya finalizó; no se pueden abrir papeletas')
      if (!assembly || !['lobby_closed', 'in_progress'].includes(assembly.status)) throw new ConflictException('El ingreso debe estar cerrado antes de abrir una papeleta')
      const otherOpen = await tx.round.findFirst({ where: { assemblyId: round.assembly_id, status: 'open' }, select: { id: true } })
      if (otherOpen) throw new ConflictException('Ya hay una papeleta abierta')
      const updated = await tx.round.update({ where: { id: round.id }, data: { status: 'open', openedAt: new Date() }, select: { id: true, assemblyId: true, title: true } })
      if (assembly.status === 'lobby_closed') await tx.assembly.update({ where: { id: round.assembly_id }, data: { status: 'in_progress' } })
      await tx.auditEvent.create({ data: { assemblyId: round.assembly_id, roundId: round.id, actorRef: MODERATOR_ACTOR, action: 'round.opened', metadata: { committeeStage: round.committee_stage } } })
      return { roundId: updated.id, assemblyId: updated.assemblyId, title: updated.title, status: 'open' as const, changed: true }
    })
    const round = await this.prisma.round.findUnique({ where: { id: roundId }, include: { options: { orderBy: { order: 'asc' } } } })
    const payload = { roundId, status: 'open' as const, title: round!.title }
    if (result.changed) {
      this.realtime.roundState(result.assemblyId, payload)
      this.realtime.roundOpened(result.assemblyId, { ...payload, options: round!.options.map((option) => ({ optionId: option.id, label: option.label })) })
      this.realtime.assemblyState(result.assemblyId, { status: 'in_progress' })
    }
    return payload
  }

  async closeRound(roundId: string) {
    const round = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; assembly_id: string; status: string; category: string; committee_type: string | null; committee_stage: string | null; committee_root_round_id: string | null; election_seats: number | null }>>`
        SELECT id, assembly_id, status, category, committee_type, committee_stage, committee_root_round_id, election_seats FROM rounds WHERE id = ${roundId}::uuid FOR UPDATE
      `
      const current = rows[0]
      if (!current) throw new NotFoundException('Ronda no encontrada')
      await tx.$queryRaw`SELECT id FROM assemblies WHERE id = ${current.assembly_id}::uuid FOR UPDATE`
      const assembly = await tx.assembly.findUnique({ where: { id: current.assembly_id }, select: { status: true } })
      if (assembly?.status === 'completed') throw new ConflictException('La Asamblea ya finalizó; no se pueden modificar sus papeletas')
      if (current.status === 'closed' || current.status === 'published') return { id: current.id, assemblyId: current.assembly_id, status: current.status, changed: false, tieBreakRoundId: null as string | null }
      if (current.status !== 'open') throw new ConflictException('Solo se puede cerrar una papeleta abierta')
      const updated = await tx.round.update({ where: { id: roundId }, data: { status: 'closed', closedAt: new Date() }, select: { id: true, assemblyId: true, status: true } })
      await tx.auditEvent.create({ data: { assemblyId: current.assembly_id, roundId, actorRef: MODERATOR_ACTOR, action: 'round.closed' } })
      let tieBreakRoundId: string | null = null
      if (current.category === 'committee' && current.committee_type === 'nomination' && ['election', 'tie_break'].includes(current.committee_stage ?? '')) {
        const rootRoundId = current.committee_root_round_id ?? current.id
        const seats = current.election_seats ?? 0
        const options = await tx.ballotOption.findMany({ where: { roundId }, orderBy: { order: 'asc' }, select: { id: true, order: true, label: true, candidateParticipantId: true } })
        const voteCounts = await tx.anonymousVote.groupBy({ by: ['optionId'], where: { roundId }, _count: { _all: true } })
        const countByOption = new Map(voteCounts.map((item) => [item.optionId, item._count._all]))
        const ranked = options.filter((option) => option.candidateParticipantId).map((option) => ({ ...option, count: countByOption.get(option.id) ?? 0 }))
          .sort((a, b) => b.count - a.count || a.order - b.order)
        const totalVotes = ranked.reduce((sum, option) => sum + option.count, 0)
        if (totalVotes > 0 && seats > 0 && ranked.length >= seats) {
          const cutoff = ranked[seats - 1]!.count
          const above = ranked.filter((option) => option.count > cutoff)
          const tiedAtCutoff = ranked.filter((option) => option.count === cutoff)
          const remainingSeats = seats - above.length
          const alreadySelected = await tx.committeeWinner.count({ where: { rootRoundId } })
          if (tiedAtCutoff.length > remainingSeats) {
            if (above.length) await tx.committeeWinner.createMany({ data: above.map((option, index) => ({ rootRoundId, candidateParticipantId: option.candidateParticipantId!, sourceRoundId: roundId, order: alreadySelected + index })), skipDuplicates: true })
            const root = await tx.round.findUniqueOrThrow({ where: { id: rootRoundId }, select: { assemblyId: true, title: true, committeeConfiguration: true } })
            const tieRound = await tx.round.create({
              data: {
                assemblyId: current.assembly_id,
                title: `${root.title} — nueva votación secreta por empate`,
                format: 'multiple_choice', category: 'committee', committeeType: 'nomination',
                memberCount: seats, decisionNote: 'Nueva votación secreta por empate en el último cupo.',
                committeeStage: 'tie_break', committeeConfiguration: (root.committeeConfiguration ?? Prisma.JsonNull) as Prisma.InputJsonValue,
                committeeRootRoundId: rootRoundId, electionSeats: remainingSeats,
                countingRule: { kind: 'count_only', reason: 'tie_break' },
                options: { create: tiedAtCutoff.map((option, order) => ({ label: option.label, order, candidateParticipantId: option.candidateParticipantId! })) },
              }, select: { id: true },
            })
            tieBreakRoundId = tieRound.id
            await tx.round.update({ where: { id: rootRoundId }, data: { committeeStage: 'tie_break_required' } })
            await tx.auditEvent.create({ data: { assemblyId: current.assembly_id, roundId: rootRoundId, actorRef: MODERATOR_ACTOR, action: 'committee.election.tie_break_required', metadata: { sourceRoundId: roundId, tieBreakRoundId, tiedCandidateCount: tiedAtCutoff.length, seatsToFill: remainingSeats } } })
          } else {
            const selected = ranked.filter((option) => option.count >= cutoff).slice(0, seats)
            if (selected.length) await tx.committeeWinner.createMany({ data: selected.map((option, index) => ({ rootRoundId, candidateParticipantId: option.candidateParticipantId!, sourceRoundId: roundId, order: alreadySelected + index })), skipDuplicates: true })
            await tx.round.update({ where: { id: rootRoundId }, data: { committeeStage: 'composition_ready' } })
            await tx.auditEvent.create({ data: { assemblyId: current.assembly_id, roundId: rootRoundId, actorRef: MODERATOR_ACTOR, action: 'committee.election.composition_ready', metadata: { sourceRoundId: roundId, provisionalWinnerCount: alreadySelected + selected.length } } })
          }
        } else {
          const rootRoundId = current.committee_root_round_id ?? current.id
          await tx.round.update({ where: { id: rootRoundId }, data: { committeeStage: 'composition_ready' } })
          await tx.auditEvent.create({ data: { assemblyId: current.assembly_id, roundId: rootRoundId, actorRef: MODERATOR_ACTOR, action: 'committee.election.no_votes_recorded', metadata: { sourceRoundId: roundId } } })
        }
      } else if (current.category === 'committee') {
        await tx.round.update({ where: { id: roundId }, data: { committeeStage: 'composition_ready' } })
        await tx.auditEvent.create({ data: { assemblyId: current.assembly_id, roundId, actorRef: MODERATOR_ACTOR, action: 'committee.election.closed_for_official_composition' } })
      }
      return { ...updated, changed: true, tieBreakRoundId }
    })
    const [recorded, eligible, title] = await Promise.all([
      this.prisma.participation.count({ where: { roundId } }),
      this.prisma.participantSession.count({ where: { assemblyId: round.assemblyId, status: 'active' } }),
      this.prisma.round.findUniqueOrThrow({ where: { id: roundId }, select: { title: true } }),
    ])
    const payload = { roundId, status: round.status as RoundStatus, title: title.title }
    if (round.changed) {
      this.realtime.roundState(round.assemblyId, payload)
      if (round.status === 'closed') this.realtime.roundClosed(round.assemblyId, roundId)
      this.realtime.participationCount(round.assemblyId, { roundId, recorded, eligible })
    }
    return { roundId, status: round.status, participation: { recorded, eligible }, ...(round.tieBreakRoundId ? { tieBreakRoundId: round.tieBreakRoundId } : {}) }
  }

  async publishRound(roundId: string) {
    const current = await this.prisma.round.findUnique({ where: { id: roundId }, select: { id: true, assemblyId: true, status: true, title: true, category: true, committeeStage: true, committeeRootRoundId: true } })
    if (!current) throw new NotFoundException('Ronda no encontrada')
    if (current.status !== 'closed' && current.status !== 'published') throw new ConflictException('Cierra la papeleta antes de publicar resultados')
    if (current.category === 'committee' && (current.committeeRootRoundId || current.committeeStage !== 'composition_ready')) {
      throw new ConflictException('Publica el conteo de la ronda principal solo cuando la elección y los desempates estén resueltos')
    }
    let publishedNow = false
    if (current.status === 'closed') {
      await this.prisma.$transaction(async (tx) => {
        const roundRows = await tx.$queryRaw<Array<{ assembly_id: string }>>`SELECT assembly_id FROM rounds WHERE id = ${roundId}::uuid FOR UPDATE`
        if (!roundRows[0]) throw new NotFoundException('Ronda no encontrada')
        await tx.$queryRaw`SELECT id FROM assemblies WHERE id = ${roundRows[0].assembly_id}::uuid FOR UPDATE`
        const assembly = await tx.assembly.findUnique({ where: { id: roundRows[0].assembly_id }, select: { status: true } })
        if (assembly?.status === 'completed') throw new ConflictException('La Asamblea ya finalizó; no se pueden modificar sus resultados')
        const latest = await tx.round.findUniqueOrThrow({ where: { id: roundId }, select: { status: true } })
        if (latest.status === 'published') return
        if (latest.status !== 'closed') throw new ConflictException('La papeleta debe estar cerrada para publicar')
        await tx.round.update({ where: { id: roundId }, data: { status: 'published', publishedAt: new Date() } })
        await tx.auditEvent.create({ data: { assemblyId: current.assemblyId, roundId, actorRef: MODERATOR_ACTOR, action: 'round.results_published' } })
        publishedNow = true
      })
    }
    const results = await this.publishedResults(roundId)
    if (!publishedNow) return { roundId, status: 'published', results }
    const payload = { roundId, options: results }
    this.realtime.roundState(current.assemblyId, { roundId, status: 'published', title: current.title })
    this.realtime.resultsPublished(current.assemblyId, payload)
    return { roundId, status: 'published', results }
  }

  async declareOfficialResult(roundId: string, input: OfficialResultDto) {
    const optionIds = [...new Set(input.optionIds)]
    if (optionIds.length !== input.optionIds.length) throw new UnprocessableEntityException('No repitas opciones en el resultado declarado')
    const note = input.note?.trim() || null
    const declared = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; assembly_id: string; status: string; category: string; committee_type: string | null; member_count: number | null }>>`
        SELECT id, assembly_id, status, category, committee_type, member_count FROM rounds WHERE id = ${roundId}::uuid FOR UPDATE
      `
      const round = rows[0]
      if (!round) throw new NotFoundException('Ronda no encontrada')
      await tx.$queryRaw`SELECT id FROM assemblies WHERE id = ${round.assembly_id}::uuid FOR UPDATE`
      if (round.status !== 'closed' && round.status !== 'published') throw new ConflictException('Cierra la papeleta antes de registrar el resultado oficial')
      if (round.category === 'committee' && round.committee_type === 'nomination') {
        const workflow = await tx.round.findUnique({ where: { id: roundId }, select: { committeeStage: true } })
        if (workflow?.committeeStage !== 'composition_ready') throw new ConflictException('Resuelve primero la elección secreta y los posibles desempates')
        const winners = await tx.committeeWinner.findMany({ where: { rootRoundId: roundId }, select: { candidateParticipantId: true } })
        if (winners.length === round.member_count) {
          const winnerIds = new Set(winners.map((winner) => winner.candidateParticipantId))
          const selectedCandidateIds = await tx.ballotOption.findMany({ where: { roundId, id: { in: optionIds } }, select: { candidateParticipantId: true } })
          if (selectedCandidateIds.some((option) => !option.candidateParticipantId || !winnerIds.has(option.candidateParticipantId)) || selectedCandidateIds.length !== winners.length) {
            throw new UnprocessableEntityException('La composición oficial debe coincidir con los resultados provisionales de las rondas secretas')
          }
        } else if (!note) {
          throw new UnprocessableEntityException('Agrega una nota de acta explicando la decisión institucional registrada sin resultado suficiente de votación')
        }
      }
      if (round.category === 'committee' && round.member_count !== null && optionIds.length !== round.member_count) {
        throw new UnprocessableEntityException(`Selecciona exactamente ${round.member_count} integrantes para la comisión`)
      }
      const options = await tx.ballotOption.findMany({ where: { roundId, id: { in: optionIds } }, select: { id: true, label: true } })
      if (options.length !== optionIds.length) throw new UnprocessableEntityException('Todas las opciones declaradas deben pertenecer a esta papeleta')
      const current = await tx.officialResult.findUnique({
        where: { roundId }, include: { options: { include: { option: { select: { label: true } } } } },
      })
      const now = new Date()
      const saved = current
        ? await tx.officialResult.update({
            where: { id: current.id },
            data: {
              note, actorRef: MODERATOR_ACTOR, declaredAt: now, publishedAt: null,
              options: { deleteMany: {}, create: optionIds.map((optionId) => ({ optionId })) },
            },
            include: { options: { include: { option: { select: { label: true } } } } },
          })
        : await tx.officialResult.create({
            data: { roundId, note, actorRef: MODERATOR_ACTOR, declaredAt: now, options: { create: optionIds.map((optionId) => ({ optionId })) } },
            include: { options: { include: { option: { select: { label: true } } } } },
          })
      await tx.auditEvent.create({
        data: {
          assemblyId: round.assembly_id, roundId, actorRef: MODERATOR_ACTOR,
          action: current ? 'round.official_result.corrected' : 'round.official_result.declared',
          occurredAt: now,
          metadata: {
            previous: current ? { optionLabels: current.options.map((item) => item.option.label), note: current.note } : null,
            declared: { optionLabels: options.map((option) => option.label), note },
          },
        },
      })
      return saved
    })
    const round = await this.prisma.round.findUniqueOrThrow({ where: { id: roundId }, select: { assemblyId: true, status: true, title: true } })
    this.realtime.roundState(round.assemblyId, { roundId, status: round.status, title: round.title })
    return this.serializeOfficialResult(declared)
  }

  async publishOfficialResult(roundId: string) {
    const published = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ assembly_id: string; status: string }>>`
        SELECT assembly_id, status FROM rounds WHERE id = ${roundId}::uuid FOR UPDATE
      `
      const round = rows[0]
      if (!round) throw new NotFoundException('Ronda no encontrada')
      await tx.$queryRaw`SELECT id FROM assemblies WHERE id = ${round.assembly_id}::uuid FOR UPDATE`
      if (round.status !== 'published') throw new ConflictException('Publica primero el conteo de la papeleta')
      const existing = await tx.officialResult.findUnique({ where: { roundId } })
      if (!existing) throw new ConflictException('Registra primero el resultado oficial de la mesa')
      if (existing.publishedAt) return tx.officialResult.findUniqueOrThrow({
        where: { roundId }, include: { options: { include: { option: { select: { label: true } } } } },
      })
      const now = new Date()
      const result = await tx.officialResult.update({
        where: { roundId }, data: { publishedAt: now },
        include: { options: { include: { option: { select: { label: true } } } } },
      })
      await tx.auditEvent.create({ data: { assemblyId: round.assembly_id, roundId, actorRef: MODERATOR_ACTOR, action: 'round.official_result.published', occurredAt: now } })
      return result
    })
    const round = await this.prisma.round.findUniqueOrThrow({ where: { id: roundId }, select: { assemblyId: true, status: true, title: true } })
    this.realtime.roundState(round.assemblyId, { roundId, status: round.status, title: round.title })
    return this.serializeOfficialResult(published)
  }

  private serializeOfficialResult(result: {
    roundId: string; note: string | null; actorRef: string; declaredAt: Date; publishedAt: Date | null;
    options: Array<{ optionId: string; option: { label: string } }>
  }) {
    return {
      roundId: result.roundId,
      elected: result.options.map(({ optionId, option }) => ({ optionId, label: option.label })),
      note: result.note,
      declaredBy: result.actorRef,
      declaredAt: result.declaredAt.toISOString(),
      publishedAt: result.publishedAt?.toISOString() ?? null,
    }
  }

  private async moderatorOfficialResult(roundId: string) {
    const result = await this.prisma.officialResult.findUnique({
      where: { roundId }, include: { options: { include: { option: { select: { label: true } } } } },
    })
    return result ? this.serializeOfficialResult(result) : null
  }

  private async publishedOfficialResult(roundId: string) {
    const result = await this.prisma.officialResult.findFirst({
      where: { roundId, publishedAt: { not: null } },
      include: { options: { include: { option: { select: { label: true } } } } },
    })
    if (!result) return null
    const serialized = this.serializeOfficialResult(result)
    return { elected: serialized.elected, note: serialized.note, declaredAt: serialized.declaredAt }
  }

  private async publishedResults(roundId: string) {
    const round = await this.prisma.round.findUnique({ where: { id: roundId }, select: { status: true } })
    if (!round || round.status !== 'published') throw new NotFoundException('Resultados no publicados')
    const [options, counts] = await Promise.all([
      this.prisma.ballotOption.findMany({ where: { roundId }, orderBy: { order: 'asc' }, select: { id: true, label: true } }),
      this.prisma.anonymousVote.groupBy({ by: ['optionId'], where: { roundId }, _count: { _all: true } }),
    ])
    const countByOption = new Map(counts.map((row) => [row.optionId, row._count._all]))
    return options.map((option) => ({ optionId: option.id, label: option.label, count: countByOption.get(option.id) ?? 0 }))
  }
}
